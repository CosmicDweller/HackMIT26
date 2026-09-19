import { Router } from "express";
import { checkReadiness } from "../services/readiness.js";

export function createHealthRouter(config) {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const { ready } = await checkReadiness(config);
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "unavailable" });
  });

  return router;
}
