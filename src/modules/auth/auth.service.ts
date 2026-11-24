import { prisma } from "../../config/database";
import { OAuth2Client } from "google-auth-library";
import { generateSessionToken } from "../../common/security/token.utils";

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

    if (!data.email || data.email_verified !== true) {
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
        if (payload && payload.email && payload.email_verified === true) {
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

    throw new Error("Unable to verify Google token");
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

    // Cryptographically signed HMAC-SHA256 session token
    const token = generateSessionToken(user.id, user.email);

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

