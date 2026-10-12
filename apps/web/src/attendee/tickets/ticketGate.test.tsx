import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketState } from './ticketState';

// The two reads the gate stands on, mocked at their seams: the ticket (indexer/chain) and the
// order the receipt watches. What is under test is the branch, not the reads.
const detail = vi.fn();
vi.mock('./useTicketDetail', () => ({ useTicketDetail: (id: string) => detail(id) }));

let orderStatus: string | null = null;
const watchOrder = vi.fn((_id: string, onChange: (order: { status: string } | null) => void) => {
  onChange(orderStatus === null ? null : { status: orderStatus });
  return () => undefined;
});
vi.mock('../../shared/api/firestore', () => ({ watchOrder: (...args: Parameters<typeof watchOrder>) => watchOrder(...args) }));

let rememberedOrder: string | null = null;
vi.mock('../purchase/orderStore', () => ({
  orderIdForToken: () => rememberedOrder,
  orderIdForEvent: () => null,
}));

const { TicketGate } = await import('./TicketGate');

const STEP = 'the admission step';

function ticket(state: TicketState) {
  return { ticket: { tokenId: '7', eventId: '3', state }, isLoading: false, isError: false };
}

function open(need: 'enter' | 'transfer' = 'enter') {
  const path = need === 'enter' ? '/tickets/7/enter' : '/tickets/7/transfer';
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tickets/:tokenId/enter" element={<TicketGate need="enter"><p>{STEP}</p></TicketGate>} />
        <Route path="/tickets/:tokenId/transfer" element={<TicketGate need="transfer"><p>{STEP}</p></TicketGate>} />
        <Route path="/tickets/:tokenId" element={<p>the ticket</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  orderStatus = null;
  rememberedOrder = null;
  detail.mockReset();
  watchOrder.mockClear();
});
afterEach(cleanup);

describe('TicketGate on /tickets/:id/enter', () => {
  it('renders the admission step for a ticket still waiting at the door', () => {
    detail.mockReturnValue(ticket('before'));
    open();
    expect(screen.getByText(STEP)).toBeInTheDocument();
  });

  it('keeps a refunded ticket out of the step and offers the way back', async () => {
    const user = userEvent.setup();
    detail.mockReturnValue(ticket('before'));
    rememberedOrder = 'order-1';
    orderStatus = 'refunded';
    open();
    expect(screen.queryByText(STEP)).not.toBeInTheDocument();
    expect(screen.getByText("Refunded ticket · it can't be used to enter")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the ticket' }));
    expect(screen.getByText('the ticket')).toBeInTheDocument();
  });

  it('reads a released order as used, even before the check-in record arrives', () => {
    detail.mockReturnValue(ticket('before'));
    rememberedOrder = 'order-1';
    orderStatus = 'released';
    open();
    expect(screen.queryByText(STEP)).not.toBeInTheDocument();
    expect(screen.getByText('Checked in')).toBeInTheDocument();
  });

  it.each([
    ['entered', 'Checked in'],
    ['cancelled', 'Cancelled'],
    ['transferred', 'Given away'],
  ] as const)('keeps a %s ticket out of the step', (state, sentence) => {
    detail.mockReturnValue(ticket(state));
    open();
    expect(screen.queryByText(STEP)).not.toBeInTheDocument();
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it('waits rather than flashing the step while the ticket is read', () => {
    detail.mockReturnValue({ ticket: undefined, isLoading: true, isError: false });
    open();
    expect(screen.queryByText(STEP)).not.toBeInTheDocument();
  });

  it('falls through to the step when the ticket cannot be read (the gate still checks)', () => {
    detail.mockReturnValue({ ticket: undefined, isLoading: false, isError: true });
    open();
    expect(screen.getByText(STEP)).toBeInTheDocument();
  });
});

describe('TicketGate on /tickets/:id/transfer', () => {
  it('keeps a refunded ticket from being handed over', () => {
    detail.mockReturnValue(ticket('before'));
    rememberedOrder = 'order-1';
    orderStatus = 'refunded';
    open('transfer');
    expect(screen.queryByText(STEP)).not.toBeInTheDocument();
    expect(screen.getByText("Refunded ticket · it can't be used to enter")).toBeInTheDocument();
  });

  it('lets a ticket waiting at the door be handed over', () => {
    detail.mockReturnValue(ticket('before'));
    open('transfer');
    expect(screen.getByText(STEP)).toBeInTheDocument();
  });
});
