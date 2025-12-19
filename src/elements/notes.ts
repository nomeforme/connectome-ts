import { Space } from '../spaces/space';
import { SpaceNotesComponent } from '../components/shared-notes';

/**
 * Create a notes component in the Space
 * 
 * Notes that exist within the Space - visible to all agents there,
 * not broadcast beyond. For working memory, processing, and 
 * agent-to-agent communication.
 */
export function createNotes(space: Space, id: string = 'notes'): SpaceNotesComponent {
  const notes = new SpaceNotesComponent();
  space.addComponent(notes, id);
  return notes;
}
