// Who the signed-in person is.
import { json, guard } from "../lib/common.mjs";
export default async (req) => {
  const g = await guard(req, { need: "limited" });
  if (g instanceof Response) return g;
  return json({ email: g.user.email, name: g.user.user_metadata?.full_name || null, role: g.role });
};
export const config = { path: "/api/auth" };
