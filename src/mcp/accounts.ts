import { type ZodRawShape, z } from 'zod'
import { ALL_CAPABILITIES, type Capability } from '../config.js'
import type { Account } from '../core/api.js'
import { ToolError } from '../errors.js'

export function eligible(accounts: Account[], tier: Capability): Account[] {
  return accounts.filter((account) => account.cfg.capabilities.has(tier))
}

function describe(account: Account): string {
  const tiers = ALL_CAPABILITIES.filter((tier) => account.cfg.capabilities.has(tier)).join(', ')
  return `${account.name} (${account.cfg.user}: ${tiers})`
}

// required with no default: a uid means something only inside its own account
export function accountField(accounts: Account[]): ZodRawShape {
  if (accounts[0].name === undefined) return {}
  const listed = accounts.map(describe)
  const last = listed.pop() as string
  const names = accounts.map((account) => account.name as string) as [string, ...string[]]
  return {
    account: z
      .enum(names)
      .describe(`Which mailbox to use: ${listed.length > 0 ? `${listed.join(', ')} or ${last}` : last}.`),
  }
}

export function pick(accounts: Account[], args: object): Account {
  if (accounts[0].name === undefined) return accounts[0]
  const name = (args as { account?: string }).account
  const account = accounts.find((candidate) => candidate.name === name)
  // the schema enum makes this unreachable, and falling back to another mailbox would be the worse failure
  if (account === undefined) throw new ToolError('policy', 'no such account')
  return account
}
