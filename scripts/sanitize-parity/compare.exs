# Replays the cases export.test.ts wrote through coelho's Elixir sanitize and
# reports every case where the canonical bytes differ. Run it from a coelho
# checkout:
#
#   MIX_ENV=test mix run /path/to/coelho_ts/scripts/sanitize-parity/compare.exs /tmp/cases.json
[path] = System.argv()
cases = path |> File.read!() |> JSON.decode!()
schema = Coelho.Schema.default()

mismatches =
  for %{"name" => name, "input" => input, "canonical" => expected} <- cases,
      actual = input |> Coelho.Document.sanitize(schema) |> Coelho.Document.canonical(),
      actual != expected do
    IO.puts("#{name}\n  input:      #{JSON.encode!(input)}\n  typescript: #{expected}\n  elixir:     #{actual}\n")
    name
  end

IO.puts("#{length(cases) - length(mismatches)} of #{length(cases)} cases agree")
if mismatches != [], do: System.halt(1)
