
export const clientId = crypto.randomUUID();

export class ApiError extends Error {
  status: number;
  override name: string;
  constructor(status: number, name: string, message: string) {
    super(message);
    this.status = status;
    this.name = name;
  }
}

export async function api<T = any>(name: string, body: unknown = {}, init?: { signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`/api/rpc/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lit-client-id': clientId },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
    signal: init?.signal,
  });
  let json: any = {};
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, json?.name ?? 'Error', json?.message ?? res.statusText);
  return json as T;
}

/** `blockId`: the block the file goes into (Settings › Audit log "Uploaded {fileName} to {pageName}"). */
export async function uploadFile(file: File | Blob, name: string, spaceId?: string, blockId?: string): Promise<{ url: string; id: string; name: string; size: number; mime: string }> {
  const q = new URLSearchParams({ name, type: (file as File).type || 'application/octet-stream', ...(spaceId ? { spaceId } : {}), ...(blockId ? { blockId } : {}) });
  const res = await fetch(`/api/upload?${q}`, { method: 'POST', body: file, credentials: 'same-origin' });
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, 'UploadError', json?.message ?? 'Upload failed');
  return json;
}
