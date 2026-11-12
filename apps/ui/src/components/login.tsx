import { useState } from "react";
import { Box, BoxFooter, Row } from "@/components/group";
import { Face } from "@/components/sidebar";
import { ThemeSwitch } from "@/components/theme-switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { secretRejected, useAdminSecret } from "@/lib/secret";

// The login form, shown instead of every page until a secret is stored. Says so when the controller rejected the last one.
export function Login() {
  const { setSecret } = useAdminSecret();
  const [value, setValue] = useState("");
  const rejected = secretRejected();
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-4">
      <div className="flex items-center gap-2.5">
        <Face />
        <div className="leading-tight">
          <div className="font-semibold">FRED</div>
          <div className="text-xs text-faint">frei · admin</div>
        </div>
      </div>
      <form
        className="w-full max-w-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) return;
          setSecret(value.trim());
        }}
      >
        <Box>
          <Row label={<Label htmlFor="secret">Admin secret</Label>}>
            <Input id="secret" type="password" autoComplete="current-password" autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
          </Row>
          <BoxFooter status={rejected ? <span className="text-bordeaux" role="alert">The controller rejected that secret.</span> : null}>
            <Button type="submit">Open</Button>
          </BoxFooter>
        </Box>
      </form>
      <ThemeSwitch />
    </div>
  );
}
