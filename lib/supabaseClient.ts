import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True only when real credentials are present — the app falls back to
 *  localStorage-only persistence when Supabase isn't configured yet. */
export const isSupabaseConfigured = Boolean(
  url && anonKey && url.startsWith("http"),
);

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!client) {
    client = createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

/* One athlete owns this app. Signing in with a real account rather than an
 * anonymous per-device one is what lets the same log open on a phone and a
 * laptop — an anonymous session lives in one browser's storage and nowhere
 * else. "Tyler" is kinder to type on a phone than an email address, so the
 * form accepts either and resolves the short name to the account. */
const ACCOUNT_EMAIL = "tylercklok@gmail.com";
export const resolveLogin = (who: string) => {
  const v = who.trim();
  return v.includes("@") ? v : ACCOUNT_EMAIL;
};

/** The signed-in athlete's id, or null when nobody is signed in.
 *  A session whose user no longer exists counts as signed out. */
export async function currentUserId(): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return null;

  /* getSession only reads local storage; getUser checks the token is still
   * good, so a stale or revoked session lands on the login screen instead of
   * failing later with an opaque error mid-render. */
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    await supabase.auth.signOut();
    return null;
  }
  return data.user.id;
}

/** Sign in. Resolves to null on success, or a message to show the athlete. */
export async function signIn(who: string, password: string): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return "The training log isn't configured on this device.";

  const { error } = await supabase.auth.signInWithPassword({
    email: resolveLogin(who),
    password,
  });
  if (!error) return null;
  /* Supabase says "Invalid login credentials" for both a wrong name and a
   * wrong password, which is the right thing to leak — pass it through. */
  return error.message;
}

export async function signOut(): Promise<void> {
  await getSupabase()?.auth.signOut();
}

/** The JWT the coach API route uses to act as this athlete under RLS. */
export async function getAccessToken(): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
