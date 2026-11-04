import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class RequestVerificationTokenBody {
  @IsString()
  @MaxLength(50)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tracking_id?: string;
}

export class RedeemVerificationTokenBody {
  @IsUUID()
  code!: string;

  @IsString()
  @MaxLength(50)
  username!: string;
}
