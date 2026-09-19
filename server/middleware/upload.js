import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import multer from "multer";
import { fileTooLarge, invalidAudio } from "../lib/errors.js";

/**
 * Accepts exactly one file in the `audio` field. The file is stored under a random
 * name in the temp directory; the client-supplied filename is never used as a path.
 */
export function createUploadMiddleware(config) {
  mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, config.tmpDir),
      filename: (_req, _file, cb) => cb(null, `upload-${randomUUID()}`),
    }),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, parts: 10 },
  }).single("audio");

  return (req, res, next) => {
    upload(req, res, (error) => {
      if (!error) return next();
      if (error.code === "LIMIT_FILE_SIZE") return next(fileTooLarge(config.maxUploadBytes));
      if (error.name === "MulterError") return next(invalidAudio("Send exactly one audio file in the 'audio' field."));
      // Malformed multipart bodies surface as plain errors from the parser.
      return next(invalidAudio("The upload could not be read. Send multipart/form-data with an 'audio' file."));
    });
  };
}
