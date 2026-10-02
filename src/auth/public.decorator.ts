import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'pp:isPublic';

// Opts a controller or handler out of ApiKeyGuard. Only for routes that
// carry their own proof (HeyGen's HMAC) or expose nothing (health, root).
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
