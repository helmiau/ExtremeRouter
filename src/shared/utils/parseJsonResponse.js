/**
 * Parse a fetch Response as JSON even on error statuses.
 *
 * Next.js returns an empty body (or HTML) for unhandled route-handler errors,
 * which makes a bare `res.json()` throw "Unexpected end of JSON input" and
 * hide the real cause. This helper guarantees either parsed JSON or a
 * descriptive Error with the server's message.
 *
 * @param {Response} res - fetch Response
 * @returns {Promise<object|null>} parsed JSON body (null when body is empty)
 * @throws {Error} with server error message (or status) when !res.ok
 */
export async function parseJsonResponse(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    data = text ? { error: text.slice(0, 300) } : null;
  }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed with status ${res.status}`);
  }
  return data;
}
