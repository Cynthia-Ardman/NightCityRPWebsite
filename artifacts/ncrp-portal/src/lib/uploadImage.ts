import { requestUploadUrl } from "@workspace/api-client-react";

/**
 * Upload an image File to object storage via the presigned-URL flow.
 *
 *   1. Ask the API for a presigned PUT URL + public object path.
 *   2. PUT the file bytes directly to GCS using that URL.
 *   3. Return the public objectPath the API gave us — that's what we store
 *      in the DB and use as <img src=...>.
 *
 * Throws on any failure (caller is responsible for showing a toast).
 */
export async function uploadImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Only image files are allowed.");
  }
  // Generous cap — portraits are usually a few hundred KB but players upload
  // hi-res stats screenshots too. Anything above 15MB is almost certainly a
  // mistake and would cripple the page anyway.
  const MAX_BYTES = 15 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    throw new Error("Image is too large (max 15 MB).");
  }

  const presigned = await requestUploadUrl({
    name: file.name,
    size: file.size,
    contentType: file.type,
  });

  const put = await fetch(presigned.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`Upload failed (${put.status}).`);
  }

  return presigned.objectPath;
}
