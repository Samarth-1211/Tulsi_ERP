import { createPrivateKey } from 'crypto';

/**
 * Runs once at startup (ConfigModule `validate`). A missing or unsafe setting
 * stops the app with a clear list instead of failing later at runtime — or
 * worse, running with an insecure default.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const get = (key: string) => (typeof config[key] === 'string' ? (config[key] as string).trim() : '');
  const isProduction = get('NODE_ENV') === 'production';
  const problems: string[] = [];

  if (!get('DATABASE_URL')) problems.push('DATABASE_URL is not set.');

  const jwtSecret = get('JWT_ACCESS_SECRET');
  if (!jwtSecret) problems.push('JWT_ACCESS_SECRET is not set.');
  else if (isProduction && (jwtSecret.length < 32 || jwtSecret === 'replace-with-a-long-random-string')) {
    problems.push('JWT_ACCESS_SECRET must be a random string of at least 32 characters in production.');
  }

  if (isProduction) {
    if (!get('CORS_ORIGINS')) problems.push('CORS_ORIGINS must list the frontend origin(s) in production.');
    if (!/^[0-9a-fA-F]{64}$/.test(get('CREDENTIALS_ENCRYPTION_KEY'))) {
      problems.push('CREDENTIALS_ENCRYPTION_KEY must be 64 hex characters in production (openssl rand -hex 32).');
    }
    if (get('AUTO_VERIFY_NEW_USERS') === 'true') {
      console.warn('[env] AUTO_VERIFY_NEW_USERS=true in production: new accounts skip email verification.');
    }
  }

  // Optional Google service account for private Google Sheet lead sources: both or neither.
  const googleEmail = get('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  const googleKey = get('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY').replace(/^"|"$/g, '').replace(/\\n/g, '\n');
  if (!!googleEmail !== !!googleKey) {
    problems.push('Set both GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (client_email and private_key from the JSON key file), or neither.');
  } else if (googleKey) {
    try {
      createPrivateKey(googleKey);
    } catch {
      problems.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not a valid private key — paste private_key from the JSON key file, in double quotes, as it is.');
    }
  }

  if (problems.length) {
    throw new Error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  }
  return config;
}
