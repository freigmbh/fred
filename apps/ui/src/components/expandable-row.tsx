import { Children, useState, type ReactNode } from "react";
import { Detail } from "@/components/group";
import { ExpandButton } from "@/components/marks";
import { TableCell, TableRow } from "@/components/ui/table";

// Keeps at most one row of a table open. Returns `rowToggle`; spread `rowToggle(id)` into each ExpandableRow, and opening
// one closes the other.
export function useOneOpenRow<Id>() {
  const [openId, setOpenId] = useState<Id | null>(null);
  return (id: Id) => ({ open: openId === id, onToggle: () => setOpenId(openId === id ? null : id) });
}

// A table row that opens `detail` in a tinted row below it. `children` are the row's TableCells, one per column and not
// wrapped in a Fragment, so the detail row spans them and the trailing ExpandButton cell. The header needs an empty
// TableHead for that cell. A click anywhere on the row toggles it; links inside stop propagation to stay links.
export function ExpandableRow({ open, onToggle, label, detail, children }: { open: boolean; onToggle: () => void; label: string; detail: ReactNode; children: ReactNode }) {
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        {children}
        <TableCell className="w-10 text-right"><ExpandButton open={open} label={label} onClick={onToggle} /></TableCell>
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={Children.count(children) + 1} className="p-0"><Detail className="border-b-0">{detail}</Detail></TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
