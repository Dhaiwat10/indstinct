import { randomBytes } from "node:crypto";
import { recoverMessageAddress, type Hex } from "viem";
import { config } from "../config.js";
import { db } from "../db/index.js";

type Signature = { text: string; signature: Hex; signing_address: string; signing_algo: string; signature_kind?: string };

export type InferenceRow = {
  id: number;
  completion_id: string;
  model: string;
  request_sha256: string;
  response_sha256: string;
  signature: string | null;
};

export type Verification = {
  model: string;
  requestHash: string;
  responseHash: string;
  signer?: string;
  /** Signed text is exactly model:sha256(request):sha256(response) of the bytes we stored. */
  hashesMatch: boolean;
  /** ECDSA signature recovers to the claimed signing address. */
  signatureValid: boolean;
  /** NEAR AI's attestation lists this signer for the model. */
  signerAttested: boolean;
  /** The TDX quote's report_data commits to this signer and to our fresh nonce. */
  quoteBindsSigner: boolean;
  /** NEAR AI Verification Center link that re-verifies this reply in the browser. */
  receiptUrl?: string;
  error?: string;
};

const auth = () => ({ authorization: `Bearer ${config.NEAR_AI_API_KEY}` });

async function fetchSignature(row: InferenceRow): Promise<Signature | undefined> {
  if (row.signature) return JSON.parse(row.signature);
  const url = `${config.NEAR_AI_BASE_URL}/signature/${encodeURIComponent(row.completion_id)}?model=${encodeURIComponent(row.model)}&signing_algo=ecdsa`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: auth() });
    if (res.ok) {
      const sig = (await res.json()) as Signature;
      db.prepare("UPDATE inference_log SET signature = ? WHERE id = ?").run(JSON.stringify(sig), row.id);
      return sig;
    }
    if (res.status !== 404) throw new Error(`signature endpoint returned ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

/**
 * TDX quote v4: 48-byte header, then the TD report body, whose 64-byte report_data sits at
 * offset 520. NEAR AI fills it with signing address (20 bytes, zero-padded to 32) + nonce.
 */
function quoteBinds(quoteHex: string, signer: string, nonce: string): boolean {
  const quote = Buffer.from(quoteHex, "hex");
  if (quote.length < 632) return false;
  const reportData = quote.subarray(568, 632).toString("hex");
  return reportData.startsWith(signer.toLowerCase().replace(/^0x/, "")) && reportData.endsWith(nonce);
}

async function checkAttestation(model: string, signer: string): Promise<{ attested: boolean; binds: boolean }> {
  const nonce = randomBytes(32).toString("hex");
  const url = `${config.NEAR_AI_BASE_URL}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
  const res = await fetch(url, { headers: auth() });
  if (!res.ok) throw new Error(`attestation endpoint returned ${res.status}`);
  const report = (await res.json()) as {
    model_attestations?: { signing_address: string; request_nonce?: string; intel_quote?: string }[];
  };
  const entry = report.model_attestations?.find((a) => a.signing_address.toLowerCase() === signer.toLowerCase());
  if (!entry) return { attested: false, binds: false };
  return {
    attested: true,
    binds: entry.request_nonce === nonce && !!entry.intel_quote && quoteBinds(entry.intel_quote, signer, nonce),
  };
}

/**
 * The Verification Center reads a base64url JSON receipt from the URL fragment, which
 * browsers never send to the server. Field names match cloud.near.ai/verify's parser.
 */
function receiptUrl(row: InferenceRow, sig: Signature): string {
  const receipt = {
    signatureKind: sig.signature_kind ?? "provider_tee",
    completionId: row.completion_id,
    model: row.model,
    signingAlgo: sig.signing_algo,
    signingAddress: sig.signing_address,
    signedText: sig.text,
    signature: sig.signature,
    verifiedAt: new Date().toISOString(),
  };
  const fragment = Buffer.from(JSON.stringify(receipt)).toString("base64url");
  return `https://cloud.near.ai/verify?model=${encodeURIComponent(row.model)}#receipt=${fragment}`;
}

export async function verifyInference(row: InferenceRow): Promise<Verification> {
  const v: Verification = {
    model: row.model,
    requestHash: row.request_sha256,
    responseHash: row.response_sha256,
    hashesMatch: false,
    signatureValid: false,
    signerAttested: false,
    quoteBindsSigner: false,
  };
  try {
    const sig = await fetchSignature(row);
    if (!sig) return { ...v, error: "signature not available yet" };
    v.signer = sig.signing_address;
    v.receiptUrl = receiptUrl(row, sig);
    v.hashesMatch = sig.text === `${row.model}:${row.request_sha256}:${row.response_sha256}`;
    const recovered = await recoverMessageAddress({ message: sig.text, signature: sig.signature });
    v.signatureValid = recovered.toLowerCase() === sig.signing_address.toLowerCase();
    const { attested, binds } = await checkAttestation(row.model, sig.signing_address);
    v.signerAttested = attested;
    v.quoteBindsSigner = binds;
  } catch (err) {
    v.error = err instanceof Error ? err.message : String(err);
  }
  return v;
}
