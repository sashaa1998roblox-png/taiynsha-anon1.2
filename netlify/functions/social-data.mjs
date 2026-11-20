import { getStore } from "@netlify/blobs";
import { accountStore, verifySession } from "./lib/accounts.mjs";

const STORE = "taiynsha-social";
const KEY = "shared-feed-v1.json";
const MAX_BODY = 900_000;
const MAX_POSTS = 800;
const MAX_PROFILES = 2000;
const MAX_VIEWERS = 20_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function token(v) {
  return String(v || "").replace(/[^\w.-]/g, "").slice(0, 80);
}

function cleanProfile(p) {
  if (!p || typeof p !== "object") return null;
  const id = String(p.id || "").slice(0, 80);
  if (!id) return null;
  const photo = typeof p.photo === "string" && p.photo.startsWith("data:image/") && p.photo.length <= 150_000 ? p.photo : "";
  const out = {
    id,
    nick: String(p.nick || "").slice(0, 60),
    username: String(p.username || "").slice(0, 40),
    avatar: String(p.avatar || "").slice(0, 8),
    bio: String(p.bio || "").slice(0, 400),
    createdAt: Number(p.createdAt) || Date.now(),
  };
  if (photo) out.photo = photo;
  return out;
}

function upsertProfile(state, p) {
  const clean = cleanProfile(p);
  if (!clean) return;
  const i = state.profiles.findIndex((x) => x.id === clean.id);
  if (i >= 0) state.profiles[i] = clean;
  else if (state.profiles.length < MAX_PROFILES) state.profiles.push(clean);
}

// Профиль принимается только от владельца аккаунта: данные берём из серверной учётной записи.
async function authedProfile(body) {
  if (!body?.session || !body?.profile) return null;
  const acc = await verifySession(accountStore(), body.session);
  if (!acc || acc.id !== String(body.profile.id || "")) return null;
  return { ...body.profile, id: acc.id, nick: acc.nick, username: acc.username, bio: acc.bio || "", createdAt: acc.createdAt };
}

function cleanPosts(value, existing) {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_POSTS) return null;
  const old = new Map((existing || []).map((p) => [p.id, p]));
  const output = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").slice(0, 80);
    const title = String(item.title || "").slice(0, 180);
    const text = String(item.text || "").slice(0, 5000);
    if (!id || (!title && !text)) continue;
    const comments = Array.isArray(item.comments) ? item.comments.slice(-150).map((c) => ({
      ...(c?.id ? { id: String(c.id).slice(0, 40) } : {}),
      ...(c?.replyTo ? { replyTo: String(c.replyTo).slice(0, 40) } : {}),
      text: String(c?.text || "").slice(0, 500),
      date: Number(c?.date) || Date.now(),
      authorId: String(c?.authorId || "").slice(0, 80),
    })) : [];
    const prev = old.get(id);
    const { liked, likedBy, viewedBy, ...rest } = item;
    output.push({
      ...rest,
      id,
      title,
      text,
      date: Number(item.date) || Date.now(),
      // Счётчики и списки зрителей принадлежат серверу: клиент их не перезаписывает.
      likes: prev ? prev.likes || 0 : Math.max(0, Math.min(1_000_000, Number(item.likes) || 0)),
      views: prev ? prev.views || 0 : Math.max(0, Math.min(10_000_000, Number(item.views) || 0)),
      likedBy: prev ? prev.likedBy || [] : [],
      viewedBy: prev ? prev.viewedBy || [] : [],
      comments,
    });
  }
  return output;
}

function publicPosts(posts, viewer) {
  return posts.map((p) => {
    const { likedBy, viewedBy, ...rest } = p;
    return { ...rest, liked: !!(viewer && Array.isArray(likedBy) && likedBy.includes(viewer)) };
  });
}

async function readState(store) {
  const res = await store.getWithMetadata(KEY, { type: "json", consistency: "strong" });
  const data = res?.data || {};
  return {
    etag: res?.etag || null,
    state: {
      posts: Array.isArray(data.posts) ? data.posts : [],
      profiles: Array.isArray(data.profiles) ? data.profiles : [],
      updatedAt: Number(data.updatedAt) || 0,
    },
  };
}

// Чтение → изменение → запись с повтором, если кто-то записал раньше нас.
async function mutate(store, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { etag, state } = await readState(store);
    const result = fn(state);
    if (result && result.error) return result;
    state.updatedAt = Date.now();
    const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const w = await store.setJSON(KEY, state, opts);
    if (!w || w.modified !== false) return { state, result };
  }
  return { error: "Conflict", status: 409 };
}

export default async (request) => {
  if (!["GET", "PUT", "POST"].includes(request.method)) {
    return json({ error: "Method not allowed" }, 405);
  }

  const store = getStore(STORE);

  // Личность зрителя: вошедший аккаунт = один зритель на всех устройствах;
  // аноним = токен браузера (он не может начинаться с "u", чтобы не выдать себя за аккаунт).
  async function resolveViewer(rawViewer, session) {
    if (session) {
      const acc = await verifySession(accountStore(), session);
      if (acc) return "u" + acc.id;
    }
    const t = token(rawViewer);
    return t.startsWith("u") ? "x" + t : t;
  }

  if (request.method === "GET") {
    const viewer = await resolveViewer(new URL(request.url).searchParams.get("viewer"), request.headers.get("x-session"));
    const { state } = await readState(store);
    return json({
      posts: publicPosts(state.posts, viewer),
      profiles: state.profiles,
      updatedAt: state.updatedAt,
    });
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY) return json({ error: "Payload too large" }, 413);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: "Payload too large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const viewer = await resolveViewer(body?.viewer, body?.session);

  if (request.method === "PUT") {
    if (!Array.isArray(body?.posts) || body.posts.length > MAX_POSTS) return json({ error: "Invalid posts data" }, 400);
    const prof = await authedProfile(body);
    const out = await mutate(store, (state) => {
      state.posts = cleanPosts(body.posts, state.posts);
      if (prof) upsertProfile(state, prof);
    });
    if (out.error) return json({ error: out.error }, out.status || 400);
    return json({ ok: true, count: out.state.posts.length, updatedAt: out.state.updatedAt });
  }

  // POST: точечные операции — просмотры, лайки, профиль.
  const op = body?.op;
  if (op === "profile") {
    const prof = await authedProfile(body);
    if (!prof) return json({ error: "no_session" }, 401);
    const out = await mutate(store, (state) => { upsertProfile(state, prof); });
    if (out.error) return json({ error: out.error }, out.status || 400);
    return json({ ok: true, updatedAt: out.state.updatedAt });
  }

  if (op === "profile_delete") {
    const acc = await verifySession(accountStore(), body.session);
    if (!acc) return json({ error: "no_session" }, 401);
    const out = await mutate(store, (state) => { state.profiles = state.profiles.filter((x) => x.id !== acc.id); });
    if (out.error) return json({ error: out.error }, out.status || 400);
    return json({ ok: true });
  }

  if (!viewer) return json({ error: "viewer required" }, 400);

  if (op === "view") {
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map((x) => String(x)) : [];
    const out = await mutate(store, (state) => {
      for (const p of state.posts) {
        if (!ids.includes(p.id)) continue;
        p.viewedBy = Array.isArray(p.viewedBy) ? p.viewedBy : [];
        if (p.viewedBy.includes(viewer)) continue;
        if (p.viewedBy.length < MAX_VIEWERS) p.viewedBy.push(viewer);
        p.views = (Number(p.views) || 0) + 1;
      }
    });
    if (out.error) return json({ error: out.error }, out.status || 400);
    return json({ ok: true, updatedAt: out.state.updatedAt, posts: publicPosts(out.state.posts, viewer).map(({ id, views, likes, liked }) => ({ id, views, likes, liked })) });
  }

  if (op === "like") {
    const id = String(body.id || "");
    const on = !!body.on;
    const out = await mutate(store, (state) => {
      const p = state.posts.find((x) => x.id === id);
      if (!p) return { error: "Post not found", status: 404 };
      p.likedBy = Array.isArray(p.likedBy) ? p.likedBy : [];
      const has = p.likedBy.includes(viewer);
      if (on && !has) { p.likedBy.push(viewer); p.likes = (Number(p.likes) || 0) + 1; }
      if (!on && has) { p.likedBy = p.likedBy.filter((v) => v !== viewer); p.likes = Math.max(0, (Number(p.likes) || 0) - 1); }
    });
    if (out.error) return json({ error: out.error }, out.status || 400);
    return json({ ok: true, updatedAt: out.state.updatedAt, posts: publicPosts(out.state.posts, viewer).map(({ id, views, likes, liked }) => ({ id, views, likes, liked })) });
  }

  return json({ error: "Unknown op" }, 400);
};
