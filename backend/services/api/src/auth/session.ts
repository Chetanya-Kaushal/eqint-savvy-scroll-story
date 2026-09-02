import jwt from 'jsonwebtoken';

export interface SessionClaims {
  userId: string;
  tenantId: string;
  role: string;
}

export function issueSessionToken(user: { id: string; tenantId: string; role: string }): string {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) throw new Error('SESSION_JWT_SECRET is not configured');
  return jwt.sign({ userId: user.id, tenantId: user.tenantId, role: user.role }, secret, { expiresIn: '8h' });
}

export function verifySessionToken(token: string): SessionClaims | null {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) throw new Error('SESSION_JWT_SECRET is not configured');
  try {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
    return { userId: decoded.userId, tenantId: decoded.tenantId, role: decoded.role };
  } catch {
    return null;
  }
}
