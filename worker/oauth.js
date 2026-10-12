const jsonHeaders = {
  accept: "application/json",
};

export const PROVIDERS = Object.freeze({
  google: Object.freeze({
    id: "google",
    name: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    supportsPkce: false,
  }),
  github: Object.freeze({
    id: "github",
    name: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    scope: "read:user user:email",
    supportsPkce: false,
  }),
  x: Object.freeze({
    id: "x",
    name: "X",
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    scope: "users.read tweet.read",
    supportsPkce: true,
  }),
});

const tokenUrls = Object.freeze({
  google: "https://oauth2.googleapis.com/token",
  github: "https://github.com/login/oauth/access_token",
  x: "https://api.x.com/2/oauth2/token",
});

function requiredCredential(env, key) {
  const value = env?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("OAuth provider is not configured");
  }
  return value;
}

function requiredSub(value, providerId) {
  if (typeof value !== "string" || value.length > 255 || value.trim() === "" || value.trim() !== value) {
    throw new Error(`OAuth ${providerId} profile has no valid subject`);
  }
  return value;
}

function githubSub(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && value.length <= 64 && /^[1-9]\d*$/u.test(value)) return value;
  throw new Error("OAuth github profile has no valid subject");
}

function nullableString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function basicAuthorization(clientId, clientSecret) {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function readJson(response, providerId, endpoint) {
  if (!response?.ok) {
    throw new Error(`OAuth ${providerId} ${endpoint} request failed`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`OAuth ${providerId} ${endpoint} returned invalid JSON`);
  }
}

async function exchangeCode(providerId, env, code, redirectUri, verifier) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const headers = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };

  if (providerId === "google") {
    form.set("client_id", requiredCredential(env, "GOOGLE_CLIENT_ID"));
    form.set("client_secret", requiredCredential(env, "GOOGLE_CLIENT_SECRET"));
  } else if (providerId === "github") {
    form.set("client_id", requiredCredential(env, "GITHUB_CLIENT_ID"));
    form.set("client_secret", requiredCredential(env, "GITHUB_CLIENT_SECRET"));
    headers.accept = "application/vnd.github+json";
  } else if (providerId === "x") {
    const clientId = requiredCredential(env, "X_CLIENT_ID");
    const clientSecret = requiredCredential(env, "X_CLIENT_SECRET");
    if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) {
      throw new Error("OAuth X PKCE verifier is invalid");
    }
    form.set("code_verifier", verifier);
    headers.authorization = basicAuthorization(clientId, clientSecret);
  } else {
    throw new Error("OAuth provider is not supported");
  }

  const response = await fetch(tokenUrls[providerId], {
    method: "POST",
    headers,
    body: form,
  });
  const token = await readJson(response, providerId, "token");
  if (typeof token.access_token !== "string" || token.access_token.length === 0) {
    throw new Error(`OAuth ${providerId} token response is invalid`);
  }
  return token.access_token;
}

export async function fetchOAuthProfile(providerId, env, code, redirectUri, verifier) {
  if (!Object.hasOwn(PROVIDERS, providerId)) {
    throw new Error("OAuth provider is not supported");
  }
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("OAuth authorization code is invalid");
  }
  let callback;
  try {
    callback = new URL(redirectUri);
  } catch {
    throw new Error("OAuth redirect URI is invalid");
  }
  if (
    callback.protocol !== "https:" ||
    callback.username || callback.password ||
    !["/api/auth/callback", "/api/auth/oauth/callback"].includes(callback.pathname) ||
    callback.search || callback.hash
  ) {
    throw new Error("OAuth redirect URI is invalid");
  }

  const accessToken = await exchangeCode(providerId, env, code, callback.href, verifier);
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: providerId === "github" ? "application/vnd.github+json" : "application/json",
  };

  if (providerId === "google") {
    const profile = await readJson(
      await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers }),
      providerId,
      "profile",
    );
    return {
      sub: requiredSub(profile.sub, providerId),
      name: nullableString(profile.name),
      email: profile.email_verified === true ? nullableString(profile.email) : null,
      picture: nullableString(profile.picture),
    };
  }

  if (providerId === "github") {
    headers["user-agent"] = "site-auth";
    const profile = await readJson(
      await fetch("https://api.github.com/user", { headers }),
      providerId,
      "profile",
    );
    const emails = await readJson(
      await fetch("https://api.github.com/user/emails", { headers }),
      providerId,
      "emails",
    );
    const verifiedEmail = Array.isArray(emails)
      ? emails.find((entry) => entry?.verified === true && entry?.primary === true)?.email ??
        emails.find((entry) => entry?.verified === true)?.email
      : null;
    return {
      sub: githubSub(profile.id),
      name: nullableString(profile.name) ?? nullableString(profile.login),
      email: nullableString(verifiedEmail),
      picture: nullableString(profile.avatar_url),
    };
  }

  const response = await readJson(
    await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url,name,username", {
      headers,
    }),
    providerId,
    "profile",
  );
  const profile = response?.data;
  if (typeof profile?.id !== "string" || profile.id.length > 64 || !/^\d+$/.test(profile.id)) {
    throw new Error("OAuth X profile has no valid subject");
  }
  return {
    sub: profile.id,
    name: nullableString(profile.name) ?? nullableString(profile.username),
    email: null,
    picture: nullableString(profile.profile_image_url),
  };
}
