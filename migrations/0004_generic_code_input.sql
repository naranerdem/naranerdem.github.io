-- Publicly entered codes may represent referral, teacher award, campaign, or
-- another configured benefit. Referral relationships remain separate.

ALTER TABLE application_child RENAME COLUMN referral_code_input TO code_input;
