import { Buffer } from "node:buffer";
import { createErrorResult, createErrorResultFromError } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

// Build auth headers from sttConfig + token
function buildAuthHeaders(cfg, token) {
  if (!token) return {};
  switch (cfg.authHeader) {
    case "bearer":      return { "Authorization": `Bearer ${token}` };
    case "token":       return { "Authorization": `Token ${token}` };
    case "x-api-key":   return { "x-api-key": token };
    case "key":         return { "Authorization": `Key ${token}` };
    case "x-gladia-key": return { "x-gladia-key": token };
    default:            return { "Authorization": `Bearer ${token}` };
  }
}

// Build a multipart body from a File + extra JSON/string fields.
// fieldMap: { fieldName: string } — file field name defaults to "file".
async function buildMultipartBody(file, extraFields = {}, fileField = "file") {
  const fd = new FormData();
  fd.append(fileField, file, file.name || "audio.wav");
  for (const [k, v] of Object.entries(extraFields)) fd.append(k, v);
  return fd;
}

// Map browser file MIME / ext → audio MIME for binary formats (deepgram/HF)
function resolveAudioContentType(file) {
  const t = (file.type || "").toLowerCase();
  if (t.startsWith("audio/")) return t;
  const name = typeof file.name === "string" ? file.name.toLowerCase() : "";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  const map = { mp3: "audio/mpeg", mp4: "audio/mp4", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm", aac: "audio/aac", opus: "audio/opus" };
  return map[ext] || "application/octet-stream";
}

async function upstreamError(res) {
  let txt = "";
  try { txt = await res.text(); } catch {}
  let msg = txt || `Upstream error (${res.status})`;
  try { const j = JSON.parse(txt); msg = j?.error?.message || j?.error || j?.message || msg; } catch {}
  return createErrorResult(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
}

// Deepgram: raw binary POST + model query param
async function transcribeDeepgram(cfg, file, model, token, formData) {
  const url = new URL(cfg.baseUrl);
  url.searchParams.set("model", model);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  const lang = formData.get("language");
  if (typeof lang === "string" && lang.trim()) url.searchParams.set("language", lang.trim());
  else url.searchParams.set("detect_language", "true");

  const buf = await file.arrayBuffer();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...buildAuthHeaders(cfg, token), "Content-Type": resolveAudioContentType(file) },
    body: buf,
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return jsonResponse({ text });
}

// AssemblyAI: upload → submit → poll (max 120s)
async function transcribeAssemblyAI(cfg, file, model, token) {
  const auth = buildAuthHeaders(cfg, token);
  const buf = await file.arrayBuffer();
  const up = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: buf,
  });
  if (!up.ok) return upstreamError(up);
  const { upload_url } = await up.json();

  const sub = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: upload_url, speech_models: [model], language_detection: true }),
  });
  if (!sub.ok) return upstreamError(sub);
  const { id } = await sub.json();

  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${cfg.baseUrl}/${id}`, { headers: auth });
    if (!poll.ok) continue;
    const r = await poll.json();
    if (r.status === "completed") return jsonResponse({ text: r.text || "" });
    if (r.status === "error") return createErrorResult(500, r.error || "AssemblyAI failed");
  }
  return createErrorResult(504, "AssemblyAI timeout after 120s");
}

// Gladia: upload → submit pre-recorded job → poll result_url (max 120s)
async function transcribeGladia(cfg, file, model, token) {
  const auth = buildAuthHeaders(cfg, token);
  const fd = await buildMultipartBody(file);
  const up = await fetch("https://api.gladia.io/v2/upload", {
    method: "POST", headers: { ...auth }, body: fd,
  });
  if (!up.ok) return upstreamError(up);
  const { audio_url } = await up.json();

  const sub = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url, model }),
  });
  if (!sub.ok) return upstreamError(sub);
  const { result_url: resultUrl } = await sub.json();
  if (!resultUrl) return createErrorResult(502, "Gladia did not return a result_url");

  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(resultUrl, { headers: auth });
    if (!poll.ok) continue;
    const result = await poll.json();
    if (result.status === "done") {
      const text = result.result?.transcription?.full_transcript || "";
      return jsonResponse({ text });
    }
    if (result.status === "error") {
      return createErrorResult(500, result.error_code || result.error || "Gladia transcription failed");
    }
  }
  return createErrorResult(504, "Gladia transcription timed out after 120s");
}

// Soniox: upload file → create transcription job → poll → fetch transcript
async function transcribeSoniox(cfg, file, model, token) {
  const auth = buildAuthHeaders(cfg, token);
  const fd = await buildMultipartBody(file);
  const up = await fetch("https://api.soniox.com/v1/files", {
    method: "POST", headers: { ...auth }, body: fd,
  });
  if (!up.ok) return upstreamError(up);
  const fileId = (await up.json()).id;

  const createRes = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model, file_id: fileId, enable_language_identification: true }),
  });
  if (!createRes.ok) return upstreamError(createRes);
  const { id: transcriptionId } = await createRes.json();

  const statusUrl = `${cfg.baseUrl}/${transcriptionId}`;
  const start = Date.now();
  let completed = false;
  while (Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(statusUrl, { headers: auth });
    if (!poll.ok) continue;
    const result = await poll.json();
    if (result.status === "completed") { completed = true; break; }
    if (result.status === "error") {
      return createErrorResult(500, result.error_message || result.error || "Soniox transcription failed");
    }
  }
  if (!completed) return createErrorResult(504, "Soniox transcription timed out after 120s");

  const transcriptRes = await fetch(`${statusUrl}/transcript`, { headers: auth });
  if (!transcriptRes.ok) return upstreamError(transcriptRes);
  const transcript = await transcriptRes.json();
  const text =
    typeof transcript.text === "string" && transcript.text.length > 0
      ? transcript.text
      : Array.isArray(transcript.tokens)
        ? transcript.tokens.map((t) => t.text ?? "").join("")
        : "";
  return jsonResponse({ text });
}

// Rev AI: submit multipart job (media + options) → poll → fetch plain-text transcript
async function transcribeRevAi(cfg, file, model, token) {
  const auth = buildAuthHeaders(cfg, token);
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");
  const fd = await buildMultipartBody(file, { options: JSON.stringify({ transcriber: model }) }, "media");

  const submitRes = await fetch(`${baseUrl}/jobs`, {
    method: "POST", headers: { ...auth }, body: fd,
  });
  if (!submitRes.ok) return upstreamError(submitRes);
  const { id: jobId } = await submitRes.json();

  const jobUrl = `${baseUrl}/jobs/${jobId}`;
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(jobUrl, { headers: auth });
    if (!poll.ok) continue;
    const result = await poll.json();
    if (result.status === "transcribed") {
      const transcriptRes = await fetch(`${jobUrl}/transcript`, { headers: { ...auth, Accept: "text/plain" } });
      if (!transcriptRes.ok) return upstreamError(transcriptRes);
      return jsonResponse({ text: (await transcriptRes.text()) || "" });
    }
    if (result.status === "failed") {
      return createErrorResult(500, result.failure_detail || "Rev AI transcription failed");
    }
  }
  return createErrorResult(504, "Rev AI transcription timed out after 120s");
}

// Speechmatics: submit multipart job (data_file + config) → poll → fetch txt transcript
async function transcribeSpeechmatics(cfg, file, model, token) {
  const auth = buildAuthHeaders(cfg, token);
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");
  const fd = await buildMultipartBody(
    file,
    { config: JSON.stringify({ type: "transcription", transcription_config: { operating_point: model } }) },
    "data_file"
  );

  const submitRes = await fetch(baseUrl, { method: "POST", headers: { ...auth }, body: fd });
  if (!submitRes.ok) return upstreamError(submitRes);
  const { id: jobId } = await submitRes.json();
  if (!jobId) return createErrorResult(502, "Speechmatics did not return a job id");

  const jobUrl = `${baseUrl}/${jobId}`;
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(jobUrl, { headers: auth });
    if (!poll.ok) continue;
    const result = await poll.json();
    const status = result?.job?.status;
    if (status === "done") {
      const transcriptRes = await fetch(`${jobUrl}/transcript?format=txt`, { headers: { ...auth, Accept: "text/plain" } });
      if (!transcriptRes.ok) return upstreamError(transcriptRes);
      return jsonResponse({ text: (await transcriptRes.text()) || "" });
    }
    if (status === "rejected") {
      const errors = result?.job?.errors;
      const first = Array.isArray(errors) ? errors[0] : null;
      return createErrorResult(500, first?.message || "Speechmatics transcription failed");
    }
  }
  return createErrorResult(504, "Speechmatics transcription timed out after 120s");
}

// Nvidia NIM: multipart, normalize response
async function transcribeNvidia(cfg, file, model, token) {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.append("model", model);
  const res = await fetch(cfg.baseUrl, { method: "POST", headers: buildAuthHeaders(cfg, token), body: fd });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  return jsonResponse({ text: data.text || data.transcript || "" });
}

// Gemini: generateContent with inline_data audio + transcription prompt
async function transcribeGemini(cfg, file, model, token, formData) {
  const buf = await file.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  const mime = resolveAudioContentType(file);
  const lang = formData.get("language");
  const userPrompt = formData.get("prompt");
  let promptText = userPrompt && typeof userPrompt === "string" && userPrompt.trim()
    ? userPrompt.trim()
    : "Generate a transcript of the speech. Return only the transcribed text, no commentary.";
  if (typeof lang === "string" && lang.trim()) promptText += ` Language: ${lang.trim()}.`;

  const url = `${cfg.baseUrl}/${model}:generateContent?key=${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mime, data: b64 } }] }],
    }),
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  return jsonResponse({ text });
}

// HuggingFace: POST raw binary to {baseUrl}/{model_id}
async function transcribeHuggingFace(cfg, file, model, token) {
  if (model.includes("..") || model.includes("//")) return createErrorResult(400, "Invalid model ID");
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/${model}`;
  const buf = await file.arrayBuffer();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...buildAuthHeaders(cfg, token), "Content-Type": resolveAudioContentType(file) },
    body: buf,
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  return jsonResponse({ text: data.text || "" });
}

// Default: OpenAI/Groq/Whisper-compatible multipart
async function transcribeOpenAICompatible(cfg, file, model, token, formData) {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.append("model", model);
  for (const k of ["language", "prompt", "response_format", "temperature"]) {
    const v = formData.get(k);
    if (v !== null && v !== undefined && v !== "") fd.append(k, v);
  }
  const res = await fetch(cfg.baseUrl, { method: "POST", headers: buildAuthHeaders(cfg, token), body: fd });
  if (!res.ok) return upstreamError(res);
  const ct = res.headers.get("content-type") || "application/json";
  const txt = await res.text();
  return { success: true, response: new Response(txt, { status: 200, headers: { "Content-Type": ct, "Access-Control-Allow-Origin": "*" } }) };
}

function jsonResponse(obj) {
  return {
    success: true,
    response: new Response(JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}

/**
 * STT core handler — dispatch by sttConfig.format.
 * @returns {Promise<{success, response, status?, error?}>}
 */
export async function handleSttCore({ provider, model, formData, credentials, sttConfig }) {
  const file = formData.get("file");
  if (!file) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const cfg = sttConfig;
  if (!cfg) return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support STT`);

  const token = cfg.authType === "none" ? null : (credentials?.apiKey || credentials?.accessToken);
  if (cfg.authType !== "none" && !token) {
    return createErrorResult(HTTP_STATUS.UNAUTHORIZED, `No credentials for STT provider: ${provider}`);
  }

  try {
    switch (cfg.format) {
      case "deepgram":        return await transcribeDeepgram(cfg, file, model, token, formData);
      case "assemblyai":      return await transcribeAssemblyAI(cfg, file, model, token);
      case "nvidia-asr":      return await transcribeNvidia(cfg, file, model, token);
      case "huggingface-asr": return await transcribeHuggingFace(cfg, file, model, token);
      case "gemini-stt":      return await transcribeGemini(cfg, file, model, token, formData);
      case "gladia":          return await transcribeGladia(cfg, file, model, token);
      case "soniox":          return await transcribeSoniox(cfg, file, model, token);
      case "rev-ai":          return await transcribeRevAi(cfg, file, model, token);
      case "speechmatics":    return await transcribeSpeechmatics(cfg, file, model, token);
      default:                return await transcribeOpenAICompatible(cfg, file, model, token, formData);
    }
  } catch (err) {
    return createErrorResultFromError(err, HTTP_STATUS.BAD_GATEWAY, err.message || "STT request failed");
  }
}
