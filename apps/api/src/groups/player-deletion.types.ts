import { IsString, MaxLength } from 'class-validator';

export class ConfirmPlayerDeletionBody {
  @IsString()
  @MaxLength(50)
  confirm_username!: string;
}
