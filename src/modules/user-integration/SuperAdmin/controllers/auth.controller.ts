import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from '../services/auth.service';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';

/** Counted per IP + email (see AppThrottlerGuard): slows password guessing and OTP/email spam. */
const LOGIN_LIMIT = { default: { limit: 10, ttl: 60_000 } };
const EMAIL_LIMIT = { default: { limit: 3, ttl: 10 * 60_000 } };
const TOKEN_LIMIT = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Throttle(LOGIN_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate with email/password and receive an access + refresh token pair' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('super-admin/login')
  @Throttle(LOGIN_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Super admin portal login — SUPER_ADMIN accounts only, unreachable from the public login form' })
  superAdminLogin(@Body() dto: LoginDto) {
    return this.authService.superAdminLogin(dto);
  }

  @Post('refresh')
  @Throttle(TOKEN_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token for a new access + refresh token pair' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @Throttle(TOKEN_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a refresh token, ending the session' })
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto);
  }

  @Post('verify-email')
  @Throttle(TOKEN_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume an emailed verification token to activate an account (and its organization, for org admins)' })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto);
  }

  @Post('forgot-password')
  @Throttle(EMAIL_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password-reset OTP be emailed to the account' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @Throttle(LOGIN_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset a password using the OTP emailed via forgot-password' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}
