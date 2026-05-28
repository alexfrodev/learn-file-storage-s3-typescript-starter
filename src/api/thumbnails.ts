import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { mediaTypeToExt, getAssetDiskPath, getAssetURL } from "./assets";

const MAX_UPLOAD_SIZE = 10 << 20;
const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png"];

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
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
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }

  const mediaType = file.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for thumbnail");
  }
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    throw new BadRequestError("File type not supported. Upload JPEG or PNG");
  }
  const fileData = await file.arrayBuffer();
  if (!fileData) {
    throw new Error("Error reading file data");
  }

  const ext = mediaTypeToExt(mediaType);
  const assetPath = `${videoId}${ext}`;
  await Bun.write(getAssetDiskPath(cfg, assetPath), fileData);

  video.thumbnailURL = getAssetURL(cfg, assetPath);
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
