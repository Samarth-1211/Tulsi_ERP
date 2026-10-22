/**
 * Email templates.
 *
 * The look mirrors the web app's teal "glass" design system (see
 * Tulsi_Frontend/src/styles.css): mint page background, white rounded card,
 * teal gradient header with the rounded logo tile, teal gradient buttons.
 *
 * Two identities send mail from this ERP, and they look deliberately
 * different:
 *
 * - `platformShell` — mail the platform itself sends (the Super Admin
 *   onboarding a new organization). Branded as TDM Groups ERP with the bright
 *   teal header.
 * - `organizationShell` — mail an organization sends to its own people (team
 *   invites, verification reminders, reset codes). The header carries that
 *   organization's name and initial on a deep-teal header, with a quiet
 *   "powered by TDM Groups ERP" underneath.
 *
 * Everything is table-based with inline styles, because email clients strip
 * <style> blocks, external CSS and most modern layout properties. Gradients
 * always sit on top of a solid `bgcolor` since Outlook drops background-image.
 */

export const PLATFORM_NAME = 'TDM Groups';
export const PRODUCT_NAME = `${PLATFORM_NAME} ERP`;
export const PLATFORM_TAGLINE = 'Your one-stop ERP for wholesale operations';

// Palette — the frontend's teal tokens.
const TEAL_50 = '#f0fdfa';
const TEAL_100 = '#ccfbf1';
const TEAL_600 = '#0d9488';
const TEAL_700 = '#0f766e';
const TEAL_950 = '#042f2e';
const INK = '#0f2523';
const BODY_TEXT = '#36504c';
const MUTED = '#6a827e';
const FAINT = '#9fb3af';
const BORDER = '#d9eeeb';
const PAGE_BG = '#eef8f7';
const CTA_SOLID = TEAL_600;
const CTA_GRADIENT = 'linear-gradient(135deg, #2dd4bf 0%, #0d9488 100%)';

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', 'Cascadia Code', Consolas, 'Liberation Mono', Menlo, monospace";

interface Brand {
  /** Wordmark shown large in the header. */
  wordmark: string;
  /** Letter in the rounded logo tile. */
  initial: string;
  /** One line under the wordmark. */
  tagline: string;
  /** Solid header colour — the fallback Outlook actually renders. */
  headerSolid: string;
  /** Gradient applied over the solid colour everywhere else. */
  headerGradient: string;
  /** Small print in the footer. */
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

function initialOf(name: string): string {
  return (name.trim().charAt(0) || 'T').toUpperCase();
}

export function platformBrand(): Brand {
  return {
    wordmark: PRODUCT_NAME,
    initial: initialOf(PLATFORM_NAME),
    tagline: PLATFORM_TAGLINE,
    headerSolid: TEAL_600,
    headerGradient: 'linear-gradient(135deg, #2dd4bf 0%, #0d9488 55%, #0e7490 100%)',
    footnote: `Sent by ${PRODUCT_NAME} — sales, team and operations in one place.`,
  };
}

export function organizationBrand(orgName: string): Brand {
  return {
    wordmark: orgName,
    initial: initialOf(orgName),
    tagline: `Powered by ${PRODUCT_NAME}`,
    headerSolid: '#115e59',
    headerGradient: 'linear-gradient(135deg, #042f2e 0%, #115e59 55%, #0f766e 100%)',
    footnote: `Sent on behalf of ${orgName} via ${PRODUCT_NAME}.`,
  };
}

/** CTA with the colour on the <td>, so it survives clients that restyle anchors. */
export function button(label: string, url: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 30px 0 26px;">
      <tr>
        <td align="center" bgcolor="${CTA_SOLID}" style="border-radius: 12px; background-color: ${CTA_SOLID}; background-image: ${CTA_GRADIENT}; box-shadow: 0 10px 22px -10px rgba(13, 148, 136, 0.85);">
          <a href="${escapeHtml(url)}" style="display: inline-block; padding: 15px 34px; font-family: ${FONT}; font-size: 15px; font-weight: 700; letter-spacing: 0.1px; color: #ffffff; text-decoration: none; border-radius: 12px;">${escapeHtml(label)} &nbsp;&rarr;</a>
        </td>
      </tr>
    </table>`;
}

export function paragraph(html: string): string {
  return `<p style="margin: 0 0 16px; font-family: ${FONT}; font-size: 15px; line-height: 25px; color: ${BODY_TEXT};">${html}</p>`;
}

export function greeting(name: string): string {
  return `<p style="margin: 0 0 16px; font-family: ${FONT}; font-size: 16px; line-height: 26px; font-weight: 600; color: ${INK};">Hi ${escapeHtml(name)},</p>`;
}

/** Login credentials in a mint panel with a teal accent edge. */
export function credentialsPanel(email: string, tempPassword: string): string {
  const row = (label: string, value: string, mono = false) => `
    <tr>
      <td style="padding: 0 0 4px; font-family: ${FONT}; font-size: 11px; font-weight: 600; letter-spacing: 0.9px; text-transform: uppercase; color: ${MUTED};">${label}</td>
    </tr>
    <tr>
      <td style="padding: 0 0 16px; font-family: ${mono ? MONO : FONT}; font-size: ${mono ? 16 : 15}px; font-weight: 700; color: ${TEAL_950}; word-break: break-all;">${escapeHtml(value)}</td>
    </tr>`;

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 10px 0 4px; border-collapse: separate;">
      <tr>
        <td bgcolor="${TEAL_50}" style="padding: 20px 22px 4px; background-color: ${TEAL_50}; border: 1px solid ${TEAL_100}; border-left: 4px solid ${TEAL_600}; border-radius: 12px;">
          <div style="font-family: ${FONT}; font-size: 13px; font-weight: 700; color: ${TEAL_700}; padding-bottom: 14px;">&#128272;&nbsp; Your sign-in details</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${row('Email', email)}
            ${row('Temporary password', tempPassword, true)}
          </table>
        </td>
      </tr>
    </table>`;
}

/** The reset code, one tile per character so it is easy to read off a phone. */
export function otpPanel(otp: string): string {
  const tiles = [...otp]
    .map(
      (ch) => `
          <td style="padding: 0 4px;">
            <div style="width: 44px; height: 54px; line-height: 54px; text-align: center; background-color: #ffffff; border: 1px solid ${TEAL_100}; border-radius: 10px; font-family: ${MONO}; font-size: 26px; font-weight: 700; color: ${TEAL_950};">${escapeHtml(ch)}</div>
          </td>`,
    )
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 22px 0;">
      <tr>
        <td align="center" bgcolor="${TEAL_50}" style="padding: 26px 16px; background-color: ${TEAL_50}; border: 1px solid ${TEAL_100}; border-radius: 14px;">
          <div style="font-family: ${FONT}; font-size: 11px; font-weight: 600; letter-spacing: 0.9px; text-transform: uppercase; color: ${MUTED}; padding-bottom: 14px;">Your verification code</div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>${tiles}
            </tr>
          </table>
          <div style="font-family: ${FONT}; font-size: 13px; color: ${TEAL_700}; font-weight: 600; padding-top: 14px;">&#9201;&nbsp; Valid for 10 minutes</div>
        </td>
      </tr>
    </table>`;
}

/** Numbered "what happens next" list with teal step badges. */
export function steps(items: string[]): string {
  const rows = items
    .map(
      (html, i) => `
      <tr>
        <td valign="top" width="34" style="padding: 0 0 12px;">
          <div style="width: 24px; height: 24px; line-height: 24px; text-align: center; border-radius: 12px; background-color: ${TEAL_100}; font-family: ${FONT}; font-size: 12px; font-weight: 700; color: ${TEAL_700};">${i + 1}</div>
        </td>
        <td valign="top" style="padding: 2px 0 12px; font-family: ${FONT}; font-size: 14px; line-height: 21px; color: ${BODY_TEXT};">${html}</td>
      </tr>`,
    )
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 6px 0 8px;">${rows}
    </table>`;
}

/** CRM updates (notification digest): label chip, title linked to the record, message underneath. */
export function updateList(items: { label: string; title: string; message: string; url: string }[]): string {
  const rows = items
    .map(
      (item) => `
      <tr>
        <td style="padding: 14px 16px; border: 1px solid ${BORDER}; border-radius: 12px; background-color: #ffffff;">
          <div style="font-family: ${FONT}; font-size: 11px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; color: ${TEAL_700};">${escapeHtml(item.label)}</div>
          <a href="${escapeHtml(item.url)}" style="display: block; padding-top: 4px; font-family: ${FONT}; font-size: 15px; line-height: 22px; font-weight: 700; color: ${INK}; text-decoration: none;">${escapeHtml(item.title)}</a>
          <div style="padding-top: 2px; font-family: ${FONT}; font-size: 14px; line-height: 21px; color: ${BODY_TEXT};">${escapeHtml(item.message)}</div>
        </td>
      </tr>
      <tr><td style="height: 10px; line-height: 10px; font-size: 1px;">&nbsp;</td></tr>`,
    )
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 6px 0 4px;">${rows}
    </table>`;
}

/** Three-up feature tiles that show what the ERP covers. Stacks fine on mobile because each tile is narrow. */
export function featureGrid(features: { icon: string; title: string; text: string }[]): string {
  const cells = features
    .map(
      (f) => `
        <td valign="top" width="${Math.floor(100 / features.length)}%" style="padding: 0 5px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td bgcolor="#ffffff" style="padding: 16px 12px; background-color: #ffffff; border: 1px solid ${BORDER}; border-radius: 12px;">
                <div style="font-size: 22px; line-height: 26px;">${f.icon}</div>
                <div style="font-family: ${FONT}; font-size: 13px; font-weight: 700; color: ${INK}; padding-top: 8px;">${escapeHtml(f.title)}</div>
                <div style="font-family: ${FONT}; font-size: 12px; line-height: 18px; color: ${MUTED}; padding-top: 3px;">${escapeHtml(f.text)}</div>
              </td>
            </tr>
          </table>
        </td>`,
    )
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 26px 0 6px;">
      <tr>
        <td style="padding: 0 0 12px; font-family: ${FONT}; font-size: 11px; font-weight: 600; letter-spacing: 0.9px; text-transform: uppercase; color: ${MUTED};">What's inside</td>
      </tr>
      <tr>
        <td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>${cells}
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
}

/** Quiet aside for fallback links and security notes. */
export function note(html: string): string {
  return `<p style="margin: 20px 0 0; padding-top: 18px; border-top: 1px solid ${BORDER}; font-family: ${FONT}; font-size: 13px; line-height: 21px; color: ${MUTED};">${html}</p>`;
}

export function fallbackLink(url: string): string {
  return note(
    `Button not working? Paste this link into your browser:<br/><a href="${escapeHtml(url)}" style="color: ${TEAL_700}; word-break: break-all;">${escapeHtml(url)}</a>`,
  );
}

interface ShellParams {
  /** Preview line shown next to the subject in the inbox. */
  preheader: string;
  /** Small uppercase label above the headline, e.g. "Welcome aboard". */
  eyebrow?: string;
  /** Headline inside the card. */
  heading: string;
  bodyHtml: string;
}

function logoTile(initial: string, size: number, radius: number, fontSize: number, onDark: boolean): string {
  const bg = onDark ? 'rgba(255, 255, 255, 0.18)' : TEAL_600;
  const solid = onDark ? '#2a8f86' : TEAL_600;
  const border = onDark ? '1px solid rgba(255, 255, 255, 0.35)' : 'none';
  return `<div style="width: ${size}px; height: ${size}px; line-height: ${size}px; text-align: center; border-radius: ${radius}px; background-color: ${solid}; background: ${bg}; border: ${border}; font-family: ${FONT}; font-size: ${fontSize}px; font-weight: 800; color: #ffffff;">${escapeHtml(initial)}</div>`;
}

function shell(brand: Brand, { preheader, eyebrow, heading, bodyHtml }: ShellParams): string {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light"/>
<title>${escapeHtml(heading)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"/>
</head>
<body style="margin: 0; padding: 0; background-color: ${PAGE_BG}; -webkit-font-smoothing: antialiased;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent; font-size: 1px; line-height: 1px;">${escapeHtml(preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="background-color: ${PAGE_BG}; background-image: linear-gradient(180deg, #e3f7f4 0%, ${PAGE_BG} 45%, #f3faf9 100%);">
    <tr>
      <td align="center" style="padding: 36px 14px 28px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px; background-color: #ffffff; border: 1px solid ${BORDER}; border-radius: 20px; overflow: hidden; box-shadow: 0 24px 60px -28px rgba(15, 80, 75, 0.35);">

          <tr>
            <td bgcolor="${brand.headerSolid}" style="background-color: ${brand.headerSolid}; background-image: ${brand.headerGradient}; padding: 30px 32px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="padding-right: 14px;">${logoTile(brand.initial, 46, 14, 21, true)}</td>
                  <td valign="middle">
                    <div style="font-family: ${FONT}; font-size: 21px; font-weight: 800; letter-spacing: -0.3px; color: #ffffff;">${escapeHtml(brand.wordmark)}</div>
                    <div style="font-family: ${FONT}; font-size: 13px; line-height: 19px; color: rgba(255, 255, 255, 0.85); padding-top: 2px;">${escapeHtml(brand.tagline)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 36px 34px 34px;">
              ${
                eyebrow
                  ? `<div style="display: inline-block; margin: 0 0 12px; padding: 5px 11px; border-radius: 999px; background-color: ${TEAL_50}; border: 1px solid ${TEAL_100}; font-family: ${FONT}; font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: ${TEAL_700};">${escapeHtml(eyebrow)}</div>`
                  : ''
              }
              <h1 style="margin: 0 0 20px; font-family: ${FONT}; font-size: 24px; line-height: 32px; font-weight: 800; letter-spacing: -0.3px; color: ${TEAL_950};">${escapeHtml(heading)}</h1>
              ${bodyHtml}
            </td>
          </tr>

        </table>

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px;">
          <tr>
            <td align="center" style="padding: 26px 24px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="padding-right: 8px;">${logoTile(initialOf(PLATFORM_NAME), 22, 7, 11, false)}</td>
                  <td valign="middle" style="font-family: ${FONT}; font-size: 13px; font-weight: 700; color: ${TEAL_700};">${escapeHtml(PRODUCT_NAME)}</td>
                </tr>
              </table>
              <div style="font-family: ${FONT}; font-size: 12px; line-height: 19px; color: ${MUTED}; padding-top: 10px;">${escapeHtml(brand.footnote)}</div>
              <div style="font-family: ${FONT}; font-size: 12px; line-height: 19px; color: ${FAINT}; padding-top: 4px;">This is an automated message — please do not reply. &copy; ${year} ${escapeHtml(PLATFORM_NAME)}</div>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Wraps content in TDM Groups ERP branding. */
export function platformShell(params: ShellParams): string {
  return shell(platformBrand(), params);
}

/** Wraps content in the sending organization's branding. */
export function organizationShell(orgName: string, params: ShellParams): string {
  return shell(organizationBrand(orgName), params);
}
