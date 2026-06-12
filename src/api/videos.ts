import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";

import path from "path";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { uploadVideoToS3 } from "../s3";

async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed: ${stderrText}`);
  }

  const { streams } = JSON.parse(stdoutText) as {
    streams: { width: number; height: number }[];
  };
  const { width, height } = streams[0];

  if (width > height) return "landscape";
  if (height > width) return "portrait";
  return "other";
}

async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const outputFilePath = `${inputFilePath}.processed`;

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed: ${stderrText}`);
  }

  return outputFilePath;
}

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

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  let processedFilePath: string | undefined;
  try {
    await Bun.write(tempFilePath, file);

    processedFilePath = await processVideoForFastStart(tempFilePath);

    const aspectRatio = await getVideoAspectRatio(processedFilePath);

    const key = `${aspectRatio}/${videoId}.mp4`;
    await uploadVideoToS3(cfg, key, processedFilePath, mediaType);

    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    updateVideo(cfg.db, { ...video, videoURL });
  } finally {
    await Bun.file(tempFilePath).unlink();
    if (processedFilePath) await Bun.file(processedFilePath).unlink();
  }

  return respondWithJSON(200, null);
}
