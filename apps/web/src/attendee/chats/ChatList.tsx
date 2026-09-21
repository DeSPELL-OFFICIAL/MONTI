import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link } from 'react-router-dom';
import { Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useChatList, type ChatEntry } from './useChats';

/**
 * What separates a tap from a drag. The whole row carries the drag listeners and the whole row
 * is also a link into the room, so without a delay dnd-kit would claim the very first
 * pointer-down and a tap meant to open the room would be swallowed. 200 ms is also what the
 * copy promises — 길게 눌러 순서를 바꿀 수 있어요 / Press and hold to reorder — and `tolerance`
 * lets a thumb wobble 5 px during that wait without cancelling it.
 */
export const DRAG_ACTIVATION = { delay: 200, tolerance: 5 } as const;

function Row({ entry }: { entry: ChatEntry }) {
  const copy = useCopy();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: entry.eventId,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, marginBottom: 12 }}
      {...attributes}
      {...listeners}
    >
      <Link to={`/chats/${entry.eventId}`}>
        #{entry.eventId}
        {entry.closed ? ` · ${copy.chats.closed}` : ''}
      </Link>
    </li>
  );
}

export function ChatList() {
  const copy = useCopy();
  const { entries, isLoading, reorder } = useChatList();
  // Touch and mouse both wait out the press; the keyboard sensor makes the same reorder
  // reachable without one, since the row is focusable anyway.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: DRAG_ACTIVATION }),
    useSensor(TouchSensor, { activationConstraint: DRAG_ACTIVATION }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    reorder(String(active.id), String(over.id));
  }

  return (
    <Screen title={copy.chats.title}>
      {isLoading ? <Spinner /> : null}
      {/* While the tickets are still arriving, "no chats yet" is not yet true. */}
      {!isLoading && entries.length === 0 ? <p className="muted">{copy.chats.empty}</p> : null}
      {entries.length > 0 ? <p className="muted">{copy.chats.reorderHint}</p> : null}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext
          items={entries.map((entry) => entry.eventId)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="event-list" style={{ listStyle: 'none', padding: 0 }}>
            {entries.map((entry) => (
              <Row key={entry.eventId} entry={entry} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </Screen>
  );
}
