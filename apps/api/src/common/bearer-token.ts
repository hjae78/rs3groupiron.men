export function stripBearer(raw: string): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(raw);
  return (bearer ? bearer[1] : raw).trim();
}
