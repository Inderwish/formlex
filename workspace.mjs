export function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(Error('工作台地址必须是有效的本机 HTTP 地址。'), { code: 'INVALID_INPUT' }); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Object.assign(Error('只可连接 http://127.0.0.1:端口 或 http://localhost:端口。'), { code: 'INVALID_INPUT' });
  return url.origin;
}

export async function workspaceRequest(baseUrl, path, body, signal) {
  const base = validateBaseUrl(baseUrl);
  const signals = [AbortSignal.timeout(12000), ...(signal ? [signal] : [])];
  let response, result;
  try {
    response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.any(signals) });
    result = await response.json();
  } catch (error) {
    const timed = error.name === 'TimeoutError' || error.name === 'AbortError';
    const message = timed ? '调用已取消或超时。' : `无法完成 FormLex 工作台请求，请确认本机服务 ${base} 已启动且响应有效。`;
    throw Object.assign(Error(message + (body === undefined ? '' : ' 抽取可能已经保存，请先在网页历史中确认，避免重复执行。')), { code: timed ? 'REQUEST_INTERRUPTED' : 'SERVICE_UNAVAILABLE', ...(body === undefined ? {} : { historySaved: null }) });
  }
  if (!response.ok) throw Object.assign(Error(result?.error?.message ?? 'FormLex 请求失败。'), { code: result?.error?.code ?? 'HTTP_ERROR', status: response.status });
  if (path === '/api/catalog' && (result?.apiVersion !== 4 || !Array.isArray(result.libraries) || !Array.isArray(result.keywords))) throw Object.assign(Error('需要支持特色与色温筛选的 HTTP API v4 工作台，请重新启动最新版 server.mjs。'), { code: 'SERVICE_VERSION' });
  return result;
}
