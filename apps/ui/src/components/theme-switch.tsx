import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { themes, useTheme, type Theme } from "@/lib/theme";

const options = {
  light: { label: "Light", Icon: SunIcon },
  dark: { label: "Dark", Icon: MoonIcon },
  system: { label: "System", Icon: MonitorIcon },
} satisfies Record<Theme, { label: string; Icon: typeof SunIcon }>;

// Light, dark, and system as a single-select icon group. Pressing the active one again keeps it.
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup aria-label="Theme" variant="outline" size="sm" spacing={0} value={[theme]}
      onValueChange={(value) => {
        const next = themes.find((option) => option === value[0]);
        if (next) setTheme(next);
      }}>
      {themes.map((value) => {
        const { label, Icon } = options[value];
        return <ToggleGroupItem key={value} value={value} aria-label={label} title={label}><Icon /></ToggleGroupItem>;
      })}
    </ToggleGroup>
  );
}
