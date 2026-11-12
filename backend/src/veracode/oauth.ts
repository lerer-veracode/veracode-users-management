import { REGIONS, type Region } from "../regions.js";

export type Credentials = { region: Region; client_id: string; client_secret: string };
export type Token = { access_token: string; expires_at: number };
export type Fetch = typeof fetch;

export class VeracodeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const REFRESH_MARGIN_MS = 60_000;

// VERACODE_API_BASE points the app at a fake Veracode for end-to-end tests. Only a local
// address is accepted, so it can never send credentials to another host.
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):\d+(\/|$)/;

export const baseUrl = (region: Region): string => {
  const override = process.env.VERACODE_API_BASE;
  return override && LOCAL.test(override) ? override.replace(/\/$/, "") : REGIONS[region].baseUrl;
};

const describe = async (res: Response): Promise<string> => {
  const text = await res.text();
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      for (const key of ["error_description", "message", "error"]) {
        if (key in body) {
          const value: unknown = Reflect.get(body, key);
          if (typeof value === "string") return value;
        }
      }
    }
  } catch {
    // Not JSON: fall through to the status text.
  }
  return res.statusText || `HTTP ${res.status}`;
};

export const failure = async (res: Response, what: string): Promise<VeracodeError> =>
  new VeracodeError(`${what} failed (${res.status}): ${await describe(res)}`, res.status);

export const requestToken = async (
  creds: Credentials,
  fetchFn: Fetch,
  now: number,
): Promise<Token> => {
  const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString("base64");
  const res = await fetchFn(`${baseUrl(creds.region)}/v2/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });
  if (!res.ok) throw await failure(res, "Getting a token");
  const body: unknown = await res.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    typeof body.access_token !== "string"
  ) {
    throw new VeracodeError("Getting a token failed: no access_token in the response", res.status);
  }
  const expiresIn =
    "expires_in" in body && typeof body.expires_in === "number" ? body.expires_in : 300;
  return { access_token: body.access_token, expires_at: now + expiresIn * 1000 };
};

export class TokenCache {
  private readonly tokens = new Map<string, Token>();

  constructor(
    private readonly fetchFn: Fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(creds: Credentials): Promise<string> {
    const key = `${creds.region}:${creds.client_id}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expires_at - REFRESH_MARGIN_MS > this.clock()) return cached.access_token;
    const token = await requestToken(creds, this.fetchFn, this.clock());
    this.tokens.set(key, token);
    return token.access_token;
  }

  expiresAt(creds: Pick<Credentials, "region" | "client_id">): string | null {
    const token = this.tokens.get(`${creds.region}:${creds.client_id}`);
    return token ? new Date(token.expires_at).toISOString() : null;
  }

  drop(creds: Pick<Credentials, "region" | "client_id">): void {
    this.tokens.delete(`${creds.region}:${creds.client_id}`);
  }
}

export type RevokeResult = { step: string; ok: boolean; message: string };

export const revokeConnection = async (
  creds: Credentials,
  fetchFn: Fetch,
  now: number,
): Promise<RevokeResult[]> => {
  let token: string;
  try {
    token = (await requestToken(creds, fetchFn, now)).access_token;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return [{ step: "Get a token to revoke with", ok: false, message }];
  }
  const id = encodeURIComponent(creds.client_id);
  const steps = [
    { step: "Revoke tokens", path: `/v2/oauth2/client_credentials/${id}/tokens` },
    { step: "Revoke client", path: `/v2/oauth2/client_credentials/${id}` },
  ];
  const results: RevokeResult[] = [];
  for (const { step, path } of steps) {
    try {
      const res = await fetchFn(`${baseUrl(creds.region)}${path}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      results.push(
        res.ok
          ? { step, ok: true, message: "Done" }
          : { step, ok: false, message: (await failure(res, step)).message },
      );
    } catch (e) {
      results.push({ step, ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
};
