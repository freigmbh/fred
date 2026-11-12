import { ChevronDownIcon } from "lucide-react";
import { ModelMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SelectPrefix } from "@/components/ui/native-select";

// A dropdown that selects any number of models. The closed control reads "Models  Any" or the count; the list stays open
// while items are toggled. Renders nothing when no model has been seen.
export function ModelsFilter({ options, selected, onToggle, onClear }: { options: string[]; selected: string[]; onToggle: (model: string) => void; onClear: () => void }) {
  if (options.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<Button variant="outline" aria-label="Models" />}>
        <SelectPrefix>Models</SelectPrefix>{selected.length === 0 ? "Any" : selected.length}
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-auto min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuCheckboxItem checked={selected.length === 0} onCheckedChange={onClear}>Any</DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {options.map((model) => (
            <DropdownMenuCheckboxItem key={model} checked={selected.includes(model)} onCheckedChange={() => onToggle(model)} title={model}>
              <ModelMark model={model} />
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
