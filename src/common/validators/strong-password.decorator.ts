import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** 8–128 characters with at least one letter and one digit. */
export const STRONG_PASSWORD = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/s;
export const STRONG_PASSWORD_MESSAGE = 'Password must be at least 8 characters and include a letter and a number';

/** Every place a password is SET uses this (login only checks it, so it keeps its own rule). */
export function StrongPassword(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MinLength(8, { message: STRONG_PASSWORD_MESSAGE }),
    MaxLength(128),
    Matches(STRONG_PASSWORD, { message: STRONG_PASSWORD_MESSAGE }),
  );
}
