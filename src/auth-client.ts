type SessionState = {
  authenticated: boolean;
  user: { id: string; email: string } | null;
  csrfToken: string;
  recentAuth: boolean;
};

let sessionPromise: Promise<SessionState> | null = null;

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed') as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

async function getSession(force = false): Promise<SessionState> {
  if (!sessionPromise || force) {
    sessionPromise = fetch('/shop/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
    }).then(readJson).catch(error => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

async function api(path: string, {
  method = 'POST',
  body,
}: {
  method?: string;
  body?: unknown;
} = {}) {
  const send = async (forceSession = false) => {
    const headers: Record<string, string> = {};
    if (method !== 'GET') {
      const session = await getSession(forceSession);
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = session.csrfToken;
    }
    return fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  };
  let response = await send();
  if (method !== 'GET' && response.status === 403) {
    response = await send(true);
  }
  const data = await readJson(response);
  if (typeof data.csrfToken === 'string') {
    const previous = await getSession();
    sessionPromise = Promise.resolve({ ...previous, ...data });
  }
  return data;
}

function setAuthenticated(result) {
  sessionPromise = Promise.resolve({
    authenticated: true,
    user: result.user,
    csrfToken: result.csrfToken,
    recentAuth: true,
  });
  window.dispatchEvent(new CustomEvent('shop-auth-changed'));
}

async function register(email: string, password: string) {
  const result = await api('/shop/api/auth/register', { body: { email, password } });
  setAuthenticated(result);
  return result;
}

async function login(email: string, password: string) {
  const result = await api('/shop/api/auth/login', { body: { email, password } });
  setAuthenticated(result);
  return result;
}

async function reauthenticate(password: string) {
  await api('/shop/api/auth/reauth', { body: { password } });
  const session = await getSession();
  sessionPromise = Promise.resolve({ ...session, recentAuth: true });
}

async function logout(all = false) {
  const result = await api(all ? '/shop/api/auth/logout-all' : '/shop/api/auth/logout');
  sessionPromise = Promise.resolve({
    authenticated: false,
    user: null,
    csrfToken: result.csrfToken,
    recentAuth: false,
  });
  window.dispatchEvent(new CustomEvent('shop-auth-changed'));
}

export const shopAuth = {
  api,
  getSession,
  register,
  login,
  logout,
  reauthenticate,
  async changePassword(currentPassword: string, password: string) {
    const session = await getSession(true);
    if (!session.authenticated) throw new Error('Authentication required');
    if (!session.recentAuth) await reauthenticate(currentPassword);
    return api('/shop/api/auth/password', { body: { password } });
  },
};

declare global {
  interface Window {
    shopAuth: typeof shopAuth;
  }
}

window.shopAuth = shopAuth;
