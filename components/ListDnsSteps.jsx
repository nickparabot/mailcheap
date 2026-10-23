import TableDnsRecords from "@/components/TableDnsRecords";
import TextStatus from "@/components/TextStatus";

// DNS setup steps (lib/domain-records.js, lib/website-domain-rules.js), each with its status and records, then the full
// name of one for DNS providers that ask for it.
export default function ListDnsSteps({ steps }) {
	const fullNameExample = steps.flatMap(({ records }) => records).find(({ host, name }) => host !== name)?.name;
	return (
		<>
			<ol className="divide-y divide-border/60 border-t border-border/60">
				{steps.map((step) => (
					<li key={step.key} className="flex flex-col gap-3 px-4 py-4">
						<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
							<div className="min-w-0 max-w-xl">
								<p className="text-sm font-medium">{step.title}</p>
								<p className="text-xs text-pretty text-muted-foreground">{step.description}</p>
							</div>
							<TextStatus {...step.status} className="text-xs" />
						</div>
						{step.records.length > 0 && <TableDnsRecords records={step.records} />}
					</li>
				))}
			</ol>
			{fullNameExample && (
				<p className="border-t border-border/60 px-4 py-3 text-xs text-pretty text-muted-foreground">
					If your DNS provider asks for the full name, use <span className="font-mono wrap-anywhere">{fullNameExample}</span>
				</p>
			)}
		</>
	);
}
