import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import multer from "multer";
import { fileTooLarge, invalidAudio } from "../lib/errors.js";

/**
 * Accepts exactly one file in the `audio` field. The file is stored under a random
 * name in the temp directory; the client-supplied filename is never used as a path.
 */
export function createUploadMiddleware(config, { maxBytes = config.maxUploadBytes, dir = config.tmpDir } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (_req, _file, cb) => cb(null, `upload-${randomUUID()}`),
    }),
    limits: { fileSize: maxBytes, files: 1, fields: 5, parts: 10 },
  }).single("audio");

  return (req, res, next) => {
    upload(req, res, (error) => {
      if (!error) return next();
      if (error.code === "LIMIT_FILE_SIZE") return next(fileTooLarge(maxBytes));
      if (error.name === "MulterError") return next(invalidAudio("Send exactly one audio file in the 'audio' field."));
      // Malformed multipart bodies surface as plain errors from the parser.
      return next(invalidAudio("The upload could not be read. Send multipart/form-data with an 'audio' file."));
    });
  };
}

/**
 * Voice-enrollment samples: exactly `count` files in the `samples` field plus a few text fields. Files are stored under
 * random names in the private temp directory; the caller deletes them in a finally block (raw enrollment audio is never kept).
 */
export function createSamplesUpload(config, { count, maxBytes = 25 * 1024 * 1024 }) {
  mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, config.tmpDir),
      filename: (_req, _file, cb) => cb(null, `sample-${randomUUID()}`),
    }),
    limits: { fileSize: maxBytes, files: count, fields: 5, parts: count + 5 },
  }).array("samples", count);
  return (req, res, next) => {
    upload(req, res, (error) => {
      if (!error) return next();
      if (error.code === "LIMIT_FILE_SIZE") return next(fileTooLarge(maxBytes));
      if (error.name === "MulterError") return next(invalidAudio(`Send exactly ${count} voice samples in the 'samples' field.`));
      return next(invalidAudio("The upload could not be read. Send multipart/form-data with the voice samples."));
    });
  };
}
