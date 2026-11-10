import type { TlsMethod } from '@crafty/shared';

/** The three ways of serving the app over HTTPS, as Settings → HTTPS Certificate names them. */
export const METHOD_INFO: Record<TlsMethod, { name: string; description: string }> = {
  internal: {
    name: "The app's own certificate",
    description:
      "A private certificate authority on this server signs the app's certificate. Works for any address with nothing on the internet, but each device has to trust the authority once.",
  },
  cloudflare: {
    name: "Let's Encrypt, with a domain on Cloudflare",
    description:
      "A certificate every browser already trusts, for a domain whose DNS is on Cloudflare. Nothing to install on devices, and the server needn't be reachable from the internet.",
  },
  custom: {
    name: 'Your own certificate',
    description: 'A certificate and private key you upload as a .pfx or .p12 file, from your organisation or a certificate authority.',
  },
};
