import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';

/**
 * The Israeli relay (relay/template.yaml): a Lambda in il-central-1 behind a
 * Function URL with AWS_IAM auth. GitHub Actions gets short-lived credentials
 * through OIDC (aws-actions/configure-aws-credentials, no stored keys), and
 * every request is signed with SigV4. The relay fetches one allow-listed URL
 * and answers with its status and bytes.
 */
export interface Relay {
  fetch(url: string, signal: AbortSignal): Promise<Response>;
}

export function relayFromEnv(env: NodeJS.ProcessEnv = process.env): Relay | null {
  const endpoint = env.RELAY_URL?.trim();
  if (!endpoint) return null;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('RELAY_URL is set but there are no AWS credentials (the AWS step of the workflow failed, or RELAY_ROLE_ARN is not set)');
  }
  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN,
    service: 'lambda',
    region: env.RELAY_REGION || 'il-central-1',
    // http.ts retries; aws4fetch's own retries would multiply them.
    retries: 0,
  });
  return {
    fetch: (url, signal) => {
      const body = JSON.stringify({ url });
      return aws.fetch(endpoint, {
        method: 'POST',
        // The payload hash is signed and also sent, as Lambda Function URLs accept it for POST bodies.
        headers: { 'content-type': 'application/json', 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') },
        body,
        signal,
      });
    },
  };
}

/**
 * The relay for this run, or why it cannot be used. A broken setup never stops
 * the run: the relay chains are reported down with this reason, and the other
 * chains run as usual.
 */
export function relaySetup(env: NodeJS.ProcessEnv = process.env): { relay: Relay | null; problem: string | null } {
  try {
    return { relay: relayFromEnv(env), problem: null };
  } catch (e) {
    return { relay: null, problem: e instanceof Error ? e.message : String(e) };
  }
}
