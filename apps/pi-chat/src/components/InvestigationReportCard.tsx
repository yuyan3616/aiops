import { Button } from "@components/ui/button";
import type { InvestigationReportArtifact } from "@shared/types";
import { Download, FileText } from "lucide-react";

const statusLabel: Record<InvestigationReportArtifact["status"], string> = {
  confirmed: "已确认",
  probable: "较可能",
  inconclusive: "未收敛",
};

export function InvestigationReportCard({
  report,
}: {
  report: InvestigationReportArtifact;
}) {
  const href = `/api/rca/investigations/${encodeURIComponent(report.investigationId)}/report`;
  const confidence = Math.round(report.confidence * 100);

  return (
    <section className="rca-report-card" aria-label="RCA 调查报告">
      <div className="rca-report-icon" aria-hidden>
        <FileText size={18} />
      </div>
      <div className="rca-report-copy">
        <div className="rca-report-title-row">
          <strong>调查报告已生成</strong>
          <span className="rca-report-status">{statusLabel[report.status]}</span>
        </div>
        <p className="rca-report-summary">{report.summary}</p>
        <span className="rca-report-meta">
          {report.investigationId} · 置信度 {confidence}%
        </span>
      </div>
      <Button asChild size="sm" variant="outline" className="rca-report-download">
        <a href={href} download={report.filename}>
          <Download size={14} />
          下载报告
        </a>
      </Button>
    </section>
  );
}
