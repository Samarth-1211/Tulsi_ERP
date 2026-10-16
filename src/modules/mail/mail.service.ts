import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { MailDeliveryException } from './mail-delivery.exception';
import {
  PLATFORM_NAME,
  escapeHtml as esc,
  button,
  credentialsPanel,
  fallbackLink,
  greeting,
  note,
  organizationShell,
  otpPanel,
  paragraph,
  platformShell,
} from './mail-templates';

/**
 * Outcome of a send that must not abort its caller — see MailService.attempt.
 */
export interface EmailDeliveryStatus {
  sent: boolean;
  /** Human-readable SMTP reason, present only when `sent` is false. */
  error?: string;
}

interface OrgAdminInviteParams {
  to: string;
  orgName: string;
  adminName: string;
  tempPassword: string;
  verifyUrl: string;
}

interface TeamMemberInviteParams {
  to: string;
  name: string;
  orgName: string;
  roleLabel: string;
  tempPassword: string;
  verifyUrl: string;
}

interface EmailChangeVerificationParams {
  to: string;
  name: string;
  /** Null for platform-level accounts (the Super Admin), which get platform branding. */
  orgName: string | null;
  verifyUrl: string;
}

interface PasswordResetOtpParams {
  to: string;
  name: string;
  otp: string;
  /**
   * Organization the account belongs to, used to brand the email. Omitted for
   * platform-level accounts (the Super Admin), which get TDM Groups branding
   * instead of the demo org they happen to sit in.
   */
  orgName?: string | null;
}

/**
 * Who the reminder is coming from, which decides the branding:
 * `platform` for a Super Admin chasing an org admin, `organization` for an
 * org chasing its own manager or team member.
 */
type ReminderOrigin = 'platform' | 'organization';

interface VerificationReminderParams {
  to: string;
  name: string;
  orgName: string;
  verifyUrl: string;
  origin: ReminderOrigin;
}

/**
 * Turns a nodemailer error into something an end user or admin can act on.
 * The codes come from nodemailer's SMTP transport.
 */
function describeSmtpFailure(error: Error & { code?: string; responseCode?: number }): string {
  switch (error.code) {
    case 'EAUTH':
      return 'the mail server rejected our credentials (check SMTP_USER and the SMTP_PASS app password)';
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'EDNS':
      return 'the mail server could not be reached (check SMTP_HOST, SMTP_PORT and outbound network access)';
    case 'ETIMEDOUT':
      return 'the mail server did not respond in time';
    case 'EENVELOPE':
      return 'the mail server rejected the recipient address';
    default:
      return error.message || 'the mail server rejected the message';
  }
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromEmail: string;
  private readonly defaultFromName: string;
  private readonly configured: boolean;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');
    this.defaultFromName = this.configService.get<string>('SMTP_FROM_NAME', `${PLATFORM_NAME} CRM`);
    this.fromEmail = this.configService.get<string>('SMTP_FROM_EMAIL', user ?? '');

    this.configured = Boolean(host && user && pass);
    if (!this.configured) {
      this.logger.warn('SMTP is not fully configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — emails will fail to send.');
    }

    this.transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: Number(port) === 465,
      auth: user && pass ? { user, pass } : undefined,
    });
  }

  /**
   * Whether SMTP_HOST/SMTP_USER/SMTP_PASS are all present. Lets a caller bail
   * out before doing any work when email delivery is impossible up front.
   */
  get isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Runs a send and reports the outcome instead of throwing. For flows where
   * the account has already been committed and must not be reported as failed
   * just because its invite email bounced.
   */
  async attempt(send: () => Promise<void>): Promise<EmailDeliveryStatus> {
    try {
      await send();
      return { sent: true };
    } catch (error) {
      if (error instanceof MailDeliveryException) {
        return { sent: false, error: error.reason };
      }
      throw error;
    }
  }

  /**
   * Builds the From header. The address is always the single authenticated
   * SMTP mailbox — only the display name changes, so organization mail reads
   * as coming from that company without spoofing another domain.
   */
  private buildFrom(fromName?: string): string {
    // Strip quotes, backslashes, angle brackets and CR/LF so a display name
    // can't break out of the quoted string or inject extra headers.
    const name = (fromName ?? this.defaultFromName).replace(/["\\<>\r\n]/g, '').trim();
    return name ? `"${name}" <${this.fromEmail}>` : this.fromEmail;
  }

  private async send(to: string, subject: string, html: string, fromName?: string): Promise<void> {
    if (!this.configured) {
      const reason = 'SMTP is not configured on the server (SMTP_HOST, SMTP_USER and SMTP_PASS must all be set)';
      this.logger.error(`Refusing to send "${subject}" to ${to} — ${reason}`);
      throw new MailDeliveryException(reason);
    }

    try {
      await this.transporter.sendMail({ from: this.buildFrom(fromName), to, subject, html });
    } catch (error) {
      const reason = describeSmtpFailure(error as Error & { code?: string });
      this.logger.error(`Failed to send email to ${to}: ${(error as Error).message}`);
      throw new MailDeliveryException(reason);
    }
  }

  /**
   * Super Admin onboarding a brand-new organization. This is the one email the
   * platform sends in its own name, so it carries TDM Groups branding rather
   * than the organization's.
   */
  async sendOrgAdminInvite(params: OrgAdminInviteParams): Promise<void> {
    const html = platformShell({
      preheader: `${params.orgName} is registered — verify your account to get started.`,
      heading: `Welcome to the CRM by ${PLATFORM_NAME}`,
      bodyHtml: [
        greeting(params.adminName),
        paragraph(
          `Great to have you on board. <strong>${esc(params.orgName)}</strong> is now registered on the ${PLATFORM_NAME} CRM — your one-stop solution for all real estate operations.`,
        ),
        paragraph('Verify your account below to activate the organization, then add your team and start tracking leads from day one.'),
        credentialsPanel(params.to, params.tempPassword),
        button('Verify my account', params.verifyUrl),
        note('This link is valid for 24 hours. Please change your temporary password once you have signed in.'),
        fallbackLink(params.verifyUrl),
      ].join(''),
    });

    await this.send(params.to, `Welcome to the ${PLATFORM_NAME} CRM — verify ${params.orgName}`, html);
  }

  /** An organization inviting one of its own managers or team members. */
  async sendTeamMemberInvite(params: TeamMemberInviteParams): Promise<void> {
    const html = organizationShell(params.orgName, {
      preheader: `Your ${params.orgName} CRM account is ready — verify to sign in.`,
      heading: `You're now part of the ${params.orgName} team`,
      bodyHtml: [
        greeting(params.name),
        paragraph(
          `You've been added as <strong>${esc(params.roleLabel)}</strong> on the <strong>${esc(params.orgName)}</strong> CRM. Your account is ready and waiting.`,
        ),
        paragraph('Verify your account below, sign in with the credentials here, and you can get straight to work.'),
        credentialsPanel(params.to, params.tempPassword),
        button('Verify my account', params.verifyUrl),
        note('This link is valid for 24 hours. Please change your temporary password after your first sign-in.'),
        fallbackLink(params.verifyUrl),
      ].join(''),
    });

    await this.send(params.to, `${params.orgName} — verify your CRM account`, html, this.orgFromName(params.orgName));
  }

  /**
   * Chases an account that never verified. Branded by origin: the Super Admin
   * reminding an org admin speaks as the platform, an organization reminding
   * its own people speaks as that organization.
   */
  async sendVerificationReminder(params: VerificationReminderParams): Promise<void> {
    const fromPlatform = params.origin === 'platform';

    const bodyHtml = [
      greeting(params.name),
      paragraph(
        fromPlatform
          ? `A quick reminder that your admin account for <strong>${esc(params.orgName)}</strong> is still waiting to be verified.`
          : `A quick reminder that your <strong>${esc(params.orgName)}</strong> CRM account is still waiting to be verified.`,
      ),
      paragraph('Verify below and you can sign in right away. It only takes a moment.'),
      button('Verify my account', params.verifyUrl),
      note(
        fromPlatform
          ? `This link is valid for 24 hours. If you no longer have your temporary password, reply to your ${PLATFORM_NAME} contact and we'll reissue it.`
          : "This link is valid for 24 hours. If you no longer have your temporary password, ask your administrator to resend the invite.",
      ),
      fallbackLink(params.verifyUrl),
    ].join('');

    const html = fromPlatform
      ? platformShell({
          preheader: `${params.orgName} is not verified yet — one click to finish.`,
          heading: 'Just one step left to verify',
          bodyHtml,
        })
      : organizationShell(params.orgName, {
          preheader: `Your ${params.orgName} CRM account is not verified yet.`,
          heading: 'Just one step left to verify',
          bodyHtml,
        });

    await this.send(
      params.to,
      fromPlatform
        ? `Reminder: verify your ${PLATFORM_NAME} CRM account for ${params.orgName}`
        : `Reminder: verify your ${params.orgName} CRM account`,
      html,
      fromPlatform ? undefined : this.orgFromName(params.orgName),
    );
  }

  /** Sent to the new address after an account's login email is changed. */
  async sendEmailChangeVerification(params: EmailChangeVerificationParams): Promise<void> {
    const orgName = params.orgName?.trim() || null;

    const bodyHtml = [
      greeting(params.name),
      paragraph(
        orgName
          ? `The login email for your <strong>${esc(orgName)}</strong> CRM account was changed to <strong>${esc(params.to)}</strong>.`
          : `The login email for your CRM account was changed to <strong>${esc(params.to)}</strong>.`,
      ),
      paragraph('Please confirm this is your email address. You will need to verify it before you can sign in again.'),
      button('Verify my new email', params.verifyUrl),
      note("This link is valid for 24 hours. If you didn't expect this change, contact your administrator."),
      fallbackLink(params.verifyUrl),
    ].join('');

    const html = orgName
      ? organizationShell(orgName, {
          preheader: 'Confirm your new CRM login email.',
          heading: 'Verify your new email address',
          bodyHtml,
        })
      : platformShell({
          preheader: 'Confirm your new CRM login email.',
          heading: 'Verify your new email address',
          bodyHtml,
        });

    await this.send(
      params.to,
      orgName ? `${orgName} — verify your new email address` : 'Verify your new email address',
      html,
      orgName ? this.orgFromName(orgName) : undefined,
    );
  }

  /**
   * Password reset code. Branded with the recipient's organization when they
   * have one, so the email looks like it came from their own company.
   */
  async sendPasswordResetOtp(params: PasswordResetOtpParams): Promise<void> {
    const orgName = params.orgName?.trim() || null;

    const bodyHtml = [
      greeting(params.name),
      paragraph(
        orgName
          ? `Here is the code to reset the password on your <strong>${esc(orgName)}</strong> CRM account.`
          : 'Here is the code to reset your CRM password.',
      ),
      otpPanel(params.otp),
      note("Didn't request this? You can safely ignore this email — your password stays unchanged."),
    ].join('');

    const html = orgName
      ? organizationShell(orgName, {
          preheader: `Your ${orgName} CRM reset code — valid for 10 minutes.`,
          heading: 'Your password reset code',
          bodyHtml,
        })
      : platformShell({
          preheader: 'Your CRM reset code — valid for 10 minutes.',
          heading: 'Your password reset code',
          bodyHtml,
        });

    await this.send(
      params.to,
      orgName ? `${orgName} — your password reset code` : 'Your password reset code',
      html,
      orgName ? this.orgFromName(orgName) : undefined,
    );
  }

  /**
   * Inbox sender name for organization mail, e.g. "Acme Realty via TDM Groups
   * CRM". Built on SMTP_FROM_NAME so rebranding only needs that one env var.
   */
  private orgFromName(orgName: string): string {
    return `${orgName} via ${this.defaultFromName}`;
  }
}
