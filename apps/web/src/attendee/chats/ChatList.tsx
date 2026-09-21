import { DndContext, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link } from 'react-router-dom';
import { Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useChatList, type ChatEntry } from './useChats';

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

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    reorder(String(active.id), String(over.id));
  }

  return (
    <Screen title={copy.chats.title}>
      {isLoading ? <Spinner /> : null}
      {entries.length === 0 ? (
        <p className="muted">{copy.chats.empty}</p>
      ) : (
        <p className="muted">{copy.chats.reorderHint}</p>
      )}
      <DndContext onDragEnd={onDragEnd}>
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
