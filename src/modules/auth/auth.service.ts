import { prisma } from "../../config/database";

export interface GoogleLoginDto {
  email: string;
  name: string;
  avatar?: string;
  googleId?: string;
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

