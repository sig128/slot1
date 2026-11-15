import { permanentRedirect } from "next/navigation";

/** "Los Santos right now" is gone: who's live is on the On Air page, what SLOT1 sees on Learning. */
export default function LosSantosPage(): never {
  permanentRedirect("/");
}
