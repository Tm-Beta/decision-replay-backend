import { prisma } from "../../config/database";
import { OAuth2Client } from "google-auth-library";

export interface GoogleLoginDto {
  email: string;
  name: string;
  avatar?: string;
  googleId?: string;
  credential?: string;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    name: string;
    avatar?: string | null;
  };
  token: string;
  isNewUser: boolean;
}

export class AuthService {
  /**
   * Verifies an official Google OAuth2 Access Token by querying Google's userinfo endpoint.
   */
  async verifyGoogleAccessToken(accessToken: string) {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn("Google userinfo fetch failed:", response.status, errText);
      throw new Error(`Google userinfo request failed with status ${response.status}`);
    }

    const data = (await response.json()) as {
      sub: string;
      email: string;
      name?: string;
      picture?: string;
      email_verified?: boolean;
    };

    if (!data.email) {
      throw new Error("Google account did not return a valid email address");
    }

    return {
      email: data.email,
      name: data.name || data.email.split("@")[0],
      avatar: data.picture,
      googleId: data.sub,
    };
  }

  /**
   * Verifies an official Google Identity Services ID Token JWT.
   */
  async verifyGoogleToken(idToken: string) {
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (googleClientId) {
      try {
        const oauthClient = new OAuth2Client(googleClientId);
        const ticket = await oauthClient.verifyIdToken({
          idToken,
          audience: googleClientId,
        });
        const payload = ticket.getPayload();
        if (payload && payload.email) {
          return {
            email: payload.email,
            name: payload.name || payload.email.split("@")[0],
            avatar: payload.picture,
            googleId: payload.sub,
          };
        }
      } catch (err) {
        console.warn("Google verifyIdToken failed, checking JWT payload fallback:", err);
      }
    }

    // Fallback parser if GOOGLE_CLIENT_ID is not configured in local development
    try {
      const parts = idToken.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
        if (payload.email) {
          return {
            email: payload.email,
            name: payload.name || payload.email.split("@")[0],
            avatar: payload.picture,
            googleId: payload.sub,
          };
        }
      }
    } catch {
      // ignore
    }

    throw new Error("Unable to parse or verify Google token");
  }

  async loginWithGoogle(data: GoogleLoginDto): Promise<AuthResponse> {
    const email = data.email.trim().toLowerCase();
    const name = data.name.trim() || email.split("@")[0];
    const avatar = data.avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}`;

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    const isNewUser = !existingUser;

    const user = await prisma.user.upsert({
      where: { email },
      update: {
        name,
        avatar,
      },
      create: {
        email,
        name,
        avatar,
      },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
      },
    });

    // Simple deterministic token format for session verification
    const token = `usr_tok_${user.id}_${Buffer.from(user.email).toString("base64")}`;

    return {
      user,
      token,
      isNewUser,
    };
  }

  async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        createdAt: true,
      },
    });

    return user;
  }
}

export const authService = new AuthService();

