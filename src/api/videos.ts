import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { S3Client } from "bun";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { getAssetDiskPath, getAssetPath } from "./assets";

const MAX_UPLOAD_SIZE = 1 << 30;
const ALLOWED_MEDIA_TYPES = ["video/mp4"];

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("You don't own this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }

  const mediaType = file.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for video");
  }
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    throw new BadRequestError("File type not supported. Upload MP4");
  }

  const assetPath = getAssetPath(mediaType);
  const assetDiskPath = getAssetDiskPath(cfg, assetPath);
  try {
    await Bun.write(assetDiskPath, file);

    const s3 = new S3Client({
      bucket: cfg.s3Bucket,
      region: cfg.s3Region,
      endpoint: `https://s3.${cfg.s3Region}.amazonaws.com`,
    });
    const key = `${videoId}.mp4`;
    await s3.file(key).write(Bun.file(assetDiskPath));

    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    updateVideo(cfg.db, { ...video, videoURL });
  } finally {
    await Bun.file(assetDiskPath).unlink();
  }

  return respondWithJSON(200, null);
}
