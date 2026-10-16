/**
 * Email templates.
 *
 * Two identities send mail from this CRM, and they look deliberately
 * different:
 *
 * - `platformShell` — mail the platform itself sends. Today that is only the
 *   Super Admin onboarding a new organization, so it is branded as TDM Groups
 *   with the indigo/violet header.
 * - `organizationShell` — mail an organization sends to its own people (team
 *   invites, verification reminders, reset codes). The header carries that
 *   organization's name, so the recipient sees the company they actually work
 *   for, with a quiet "powered by TDM Groups" underneath.
 *
 * Everything is table-based with inline styles, because email clients strip
 * <style> blocks, external CSS and most modern layout properties. Gradients
 * always sit on top of a solid `bgcolor` since Outlook drops background-image.
 */

export const PLATFORM_NAME = 'TDM Groups';
export const PLATFORM_TAGLINE = 'Your one-stop solution for wholesale operations';

const INK = '#0f172a';
const BODY_TEXT = '#334155';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const PAGE_BG = '#eef2f7';
const CTA = '#4f46e5';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

interface Brand {
  /** Wordmark shown large in the header. */
  wordmark: string;
  /** One line under the wordmark. */
  tagline: string;
  /** Solid header colour — the fallback Outlook actually renders. */
  headerSolid: string;
  /** Gradient applied over the solid colour everywhere else. */
  headerGradient: string;
  /** Small print above the automated-message line. */
  footnote: string;
}

/** Escapes values that land inside HTML — org and people's names are free text. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function platformBrand(): Brand {
  return {
    wordmark: PLATFORM_NAME,
    tagline: PLATFORM_TAGLINE,
    headerSolid: '#4f46e5',
    headerGradient: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 55%, #9333ea 100%)',
    footnote: `Sent by ${PLATFORM_NAME} — wholesale ERP`,
  };
}

export function organizationBrand(orgName: string): Brand {
  return {
    wordmark: orgName,
    tagline: `Powered by ${PLATFORM_NAME} CRM`,
    headerSolid: '#1e293b',
    headerGradient: 'linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #334155 100%)',
    footnote: `Sent on behalf of ${orgName} via ${PLATFORM_NAME} CRM`,
  };
}

/** CTA with the colour on the <td>, so it survives clients that restyle anchors. */
export function button(label: string, url: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 28px 0;">
      <tr>
        <td align="center" bgcolor="${CTA}" style="border-radius: 8px;">
          <a href="${escapeHtml(url)}" style="display: inline-block; padding: 14px 32px; font-family: ${FONT}; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

export function paragraph(html: string): string {
  return `<p style="margin: 0 0 16px; font-family: ${FONT}; font-size: 15px; line-height: 24px; color: ${BODY_TEXT};">${html}</p>`;
}

export function greeting(name: string): string {
  return `<p style="margin: 0 0 18px; font-family: ${FONT}; font-size: 17px; line-height: 26px; font-weight: 600; color: ${INK};">Hey ${escapeHtml(name)},</p>`;
}

/** Login credentials in a tinted panel, with the password in monospace. */
export function credentialsPanel(email: string, tempPassword: string): string {
  const row = (label: string, value: string, mono = false) => `
    <tr>
      <td style="padding: 0 0 4px; font-family: ${FONT}; font-size: 12px; letter-spacing: 0.6px; text-transform: uppercase; color: ${MUTED};">${label}</td>
    </tr>
    <tr>
      <td style="padding: 0 0 16px; font-family: ${mono ? MONO : FONT}; font-size: 15px; font-weight: 600; color: ${INK}; word-break: break-all;">${escapeHtml(value)}</td>
    </tr>`;

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0 4px; background-color: #f8fafc; border: 1px solid ${BORDER}; border-radius: 10px;">
      <tr>
        <td style="padding: 20px 22px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${row('Email', email)}
            ${row('Temporary password', tempPassword, true)}
          </table>
        </td>
      </tr>
    </table>`;
}

/** The reset code, spaced out so it is easy to read off a phone. */
export function otpPanel(otp: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 20px 0;">
      <tr>
        <td align="center" bgcolor="#f8fafc" style="padding: 26px 20px; background-color: #f8fafc; border: 1px solid ${BORDER}; border-radius: 10px;">
          <div style="font-family: ${FONT}; font-size: 12px; letter-spacing: 0.6px; text-transform: uppercase; color: ${MUTED}; padding-bottom: 10px;">Your verification code</div>
          <div style="font-family: ${MONO}; font-size: 34px; font-weight: 700; letter-spacing: 10px; color: ${INK};">${escapeHtml(otp)}</div>
          <div style="font-family: ${FONT}; font-size: 13px; color: ${MUTED}; padding-top: 12px;">Valid for 10 minutes</div>
        </td>
      </tr>
    </table>`;
}

/** Quiet aside for fallback links and security notes. */
export function note(html: string): string {
  return `<p style="margin: 18px 0 0; padding-top: 18px; border-top: 1px solid ${BORDER}; font-family: ${FONT}; font-size: 13px; line-height: 21px; color: ${MUTED};">${html}</p>`;
}

export function fallbackLink(url: string): string {
  return note(
    `Button not working? Paste this link into your browser:<br/><a href="${escapeHtml(url)}" style="color: ${CTA}; word-break: break-all;">${escapeHtml(url)}</a>`,
  );
}

interface ShellParams {
  /** Preview line shown next to the subject in the inbox. */
  preheader: string;
  /** Headline inside the card. */
  heading: string;
  bodyHtml: string;
}

function shell(brand: Brand, { preheader, heading, bodyHtml }: ShellParams): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light only"/>
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${PAGE_BG}; -webkit-font-smoothing: antialiased;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent; font-size: 1px; line-height: 1px;">${escapeHtml(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${PAGE_BG};">
    <tr>
      <td align="center" style="padding: 32px 16px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px; background-color: #ffffff; border-radius: 14px; overflow: hidden;">

          <tr>
            <td bgcolor="${brand.headerSolid}" style="background-color: ${brand.headerSolid}; background-image: ${brand.headerGradient}; padding: 34px 32px;">
              <div style="font-family: ${FONT}; font-size: 22px; font-weight: 700; letter-spacing: -0.3px; color: #ffffff;">${escapeHtml(brand.wordmark)}</div>
              <div style="font-family: ${FONT}; font-size: 13px; line-height: 20px; color: rgba(255, 255, 255, 0.82); padding-top: 6px;">${escapeHtml(brand.tagline)}</div>
            </td>
          </tr>

          <tr>
            <td style="padding: 36px 32px 34px;">
              <h1 style="margin: 0 0 20px; font-family: ${FONT}; font-size: 21px; line-height: 30px; font-weight: 700; color: ${INK};">${escapeHtml(heading)}</h1>
              ${bodyHtml}
            </td>
          </tr>

          <tr>
            <td bgcolor="#f8fafc" style="padding: 22px 32px; background-color: #f8fafc; border-top: 1px solid ${BORDER};">
              <div style="font-family: ${FONT}; font-size: 12px; line-height: 19px; color: ${MUTED};">${escapeHtml(brand.footnote)}</div>
              <div style="font-family: ${FONT}; font-size: 12px; line-height: 19px; color: #94a3b8; padding-top: 4px;">This is an automated message — please do not reply.</div>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Wraps content in TDM Groups branding. */
export function platformShell(params: ShellParams): string {
  return shell(platformBrand(), params);
}

/** Wraps content in the sending organization's branding. */
export function organizationShell(orgName: string, params: ShellParams): string {
  return shell(organizationBrand(orgName), params);
}
