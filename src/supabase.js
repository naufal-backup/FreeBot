// src/supabase.js
// Supabase management API interactions: token validation and project listing.

export async function validateSupabaseToken(pat) {
  try {
    const res = await fetch("https://api.supabase.com/v1/projects", {
      headers: { Authorization: `Bearer ${pat}` }
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listSupabaseProjects(pat) {
  try {
    const res = await fetch("https://api.supabase.com/v1/projects", {
      headers: { Authorization: `Bearer ${pat}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((p) => `- ${p.name || p.id}`).slice(0, 50);
  } catch {
    return null;
  }
}
