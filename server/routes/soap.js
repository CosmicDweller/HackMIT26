import express, { Router } from "express";
import { AppError, invalidRequest, notFound } from "../lib/errors.js";
import { exportFilename, MIME, toPdf, toText } from "../services/soap/export.js";
import { DEFAULT_TEMPLATE_ID, isTemplateId, publicTemplates } from "../services/soap/templates.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * SOAP notes. Mounted at /api (so it owns /api/soap/templates, /api/me/soap-preference and /api/transcriptions/:id/soap*).
 * Every route requires a verified session, and every store call is scoped to req.user.id from the verified token: the request body
 * never decides ownership. The parent transcription's ownership is checked before any note is touched.
 */
export function createSoapRouter(config, soap, store, authenticate) {
  const router = Router();
  router.use(authenticate);
  router.use(express.json({ limit: "256kb" }));

  const requireId = (value) => {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) throw notFound();
    return value;
  };
  const handle = (work) => async (req, res, next) => {
    try {
      await work(req, res);
    } catch (error) {
      next(error);
    }
  };
  const requireNote = (req) => {
    const note = soap.get(req.user.id, requireId(req.params.id));
    if (!note) throw notFound("This consultation has no SOAP note.");
    return note;
  };

  // ---- templates and the doctor's default ----------------------------------------------------
  router.get("/soap/templates", handle((req, res) => {
    res.json({ templates: publicTemplates(), defaultTemplateId: config.soapDefaultTemplate ?? DEFAULT_TEMPLATE_ID });
  }));

  router.get("/me/soap-preference", handle((req, res) => {
    res.json({ templateId: store.soapPreference(req.user.id) ?? config.soapDefaultTemplate ?? DEFAULT_TEMPLATE_ID });
  }));

  router.patch("/me/soap-preference", handle((req, res) => {
    const templateId = req.body?.templateId;
    if (!isTemplateId(templateId)) throw invalidRequest("Choose one of the templates from GET /api/soap/templates.");
    store.upsertDoctor({ id: req.user.id, email: req.user.email, displayName: req.user.displayName });
    res.json({ templateId: store.setSoapPreference(req.user.id, templateId) });
  }));

  // ---- one consultation's note ---------------------------------------------------------------
  router.get("/transcriptions/:id/soap", handle((req, res) => {
    res.json(requireNote(req));
  }));

  // Creation is idempotent recovery: if a note exists (in any state) it is returned unchanged, never regenerated.
  router.post("/transcriptions/:id/soap", handle(async (req, res) => {
    const id = requireId(req.params.id);
    const templateId = req.body?.templateId;
    if (templateId !== undefined && !isTemplateId(templateId)) throw invalidRequest("Unknown templateId.");
    const existed = Boolean(soap.get(req.user.id, id));
    const note = await soap.createIfAbsent(req.user.id, id, { templateId: templateId ?? null });
    res.status(existed ? 200 : 202).json(note);
  }));

  // Retrying is only possible for a failed note (never overwrites a draft the doctor may have edited).
  router.post("/transcriptions/:id/soap/retry", handle(async (req, res) => {
    res.json(await soap.retry(req.user.id, requireId(req.params.id)));
  }));

  router.patch("/transcriptions/:id/soap", handle((req, res) => {
    res.json(soap.update(req.user.id, requireId(req.params.id), { sections: req.body?.sections, revision: req.body?.revision }));
  }));

  router.post("/transcriptions/:id/soap/approve", handle((req, res) => {
    res.json(soap.approve(req.user.id, requireId(req.params.id), {
      revision: req.body?.revision,
      confirmReviewed: req.body?.confirmReviewed ?? true,
    }));
  }));

  router.post("/transcriptions/:id/soap/reconcile", handle((req, res) => {
    res.json(soap.reconcile(req.user.id, requireId(req.params.id), { revision: req.body?.revision }));
  }));

  router.post("/transcriptions/:id/soap/flags/:flagId/acknowledge", handle((req, res) => {
    res.json(soap.acknowledgeFlag(req.user.id, requireId(req.params.id), String(req.params.flagId)));
  }));

  // ---- export (approved notes only) -----------------------------------------------------------
  router.get("/transcriptions/:id/soap/export", handle((req, res) => {
    const id = requireId(req.params.id);
    const format = String(req.query.format ?? "pdf").toLowerCase();
    if (format !== "pdf" && format !== "txt") throw invalidRequest("format must be pdf or txt.");
    const note = requireNote(req);
    if (note.status !== "approved") {
      throw new AppError("NOT_APPROVED", 409, "Only an approved note can be exported. Review and approve it first.");
    }
    const transcription = store.get(req.user.id, id);
    const body = format === "pdf" ? toPdf(note, transcription) : Buffer.from(toText(note, transcription), "utf8");
    res.setHeader("Content-Type", MIME[format]);
    // A private document: never cached by an intermediary, never stored in a public directory.
    res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(note, format)}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(body);
  }));

  return router;
}
