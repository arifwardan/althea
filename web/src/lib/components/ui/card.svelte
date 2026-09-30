<script>
  import { cn } from "../../utils.js";

  let { class: className = "", children, ...rest } = $props();
</script>

<div class={cn("rounded-lg border border-border bg-card text-card-foreground", className)} {...rest}>
  {@render children?.()}
</div>
