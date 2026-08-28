/**
 * The data-access contract for the agent operations.
 *
 * Injected for the same reason `ActorSource`, `AvailabilitySource` and
 * `BookingRepository` are: the value in this domain is the ladders, the money
 * and the refusals, and none of it can be exercised properly through a database
 * connection. Behind an interface, the whole network — invite, edit, hold,
 * discount, approve, pay — runs in a millisecond against an in-memory double,
 * and the Supabase implementation is a mapping with no decisions in it.
 *
 * Every write takes the transaction handle the service pipeline opened. That is
 * not politeness: the settings row, its audit event and the idempotency
 * completion have to commit together, and a write that quietly used its own
 * connection would break that without failing anything.
 */

import type { TransactionHandle } from '../service'
import type { Commission, CommissionRuleRecord } from './commission'
import type { DiscountApproval } from './discounts'
import type { AgentHoldLedgerEntry } from './holds'
import type { AgentDirectory } from './identity'
import type { AgentInvitation, AgentOrganizationSettings } from './types'

export interface AgentSettingsStore {
  loadSettings(
    organizationId: string,
    agentUserId: string,
  ): Promise<AgentOrganizationSettings | null>

  saveSettings(
    settings: AgentOrganizationSettings,
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<AgentOrganizationSettings>

  insertInvitation(
    invitation: AgentInvitation,
    tx: TransactionHandle,
  ): Promise<AgentInvitation>

  /**
   * Attach an existing ESTIA user to this organization as an agent.
   *
   * Returns the new settings. It creates a membership and **never a user** —
   * the user already exists, which is the entire point of the middle branch in
   * `identity.ts`.
   */
  attachExistingUser(
    input: {
      organizationId: string
      userId: string
      settings: AgentOrganizationSettings
    },
    tx: TransactionHandle,
  ): Promise<AgentOrganizationSettings>
}

export interface AgentHoldStore {
  /**
   * The agent's hold ledger for this organization.
   *
   * Expired entries included, deliberately: liveness is decided in the domain
   * against the clock, so a missing sweeper cannot inflate an agent's count and
   * lock them out of their own work.
   */
  loadHoldLedger(
    organizationId: string,
    agentUserId: string,
  ): Promise<readonly AgentHoldLedgerEntry[]>

  insertLedgerEntry(
    entry: AgentHoldLedgerEntry,
    tx: TransactionHandle,
  ): Promise<AgentHoldLedgerEntry>

  saveLedgerEntry(
    entry: AgentHoldLedgerEntry,
    tx: TransactionHandle,
  ): Promise<AgentHoldLedgerEntry>
}

export interface CommissionStore {
  loadCommission(
    organizationId: string,
    commissionId: string,
  ): Promise<Commission | null>

  /** Every rule that could govern a booking. Filtering is the domain's job. */
  loadCommissionRules(
    organizationId: string,
  ): Promise<readonly CommissionRuleRecord[]>

  saveCommission(
    commission: Commission,
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<Commission>
}

export interface ApprovalStore {
  loadApproval(
    organizationId: string,
    approvalId: string,
  ): Promise<DiscountApproval | null>

  insertApproval(
    approval: DiscountApproval,
    tx: TransactionHandle,
  ): Promise<DiscountApproval>

  saveApproval(
    approval: DiscountApproval,
    tx: TransactionHandle,
  ): Promise<DiscountApproval>
}

export interface AgentRepository
  extends
    AgentDirectory,
    AgentSettingsStore,
    AgentHoldStore,
    CommissionStore,
    ApprovalStore {}
