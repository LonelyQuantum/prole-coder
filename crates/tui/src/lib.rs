#![forbid(unsafe_code)]

use prole_coder_agent_core::{
    approval::ApprovalPersistence,
    turn_loop::{ApprovalDecision, TurnApprovalRequest},
};

pub const APPROVAL_REJECTED_REASON: &str = "rejected in TUI";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalPromptAction {
    Pending,
    Approved { persist: ApprovalPersistence },
    Rejected { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalPromptModel {
    request: TurnApprovalRequest,
    persist: ApprovalPersistence,
}

impl ApprovalPromptModel {
    pub fn new(request: TurnApprovalRequest) -> Self {
        Self {
            request,
            persist: ApprovalPersistence::Never,
        }
    }

    pub const fn request(&self) -> &TurnApprovalRequest {
        &self.request
    }

    pub const fn persist(&self) -> ApprovalPersistence {
        self.persist
    }

    pub fn render_lines(&self) -> Vec<String> {
        let mut lines = vec![
            "Approval required".to_owned(),
            format!("id: {}", self.request.approval_id),
            format!("tool: {}", self.request.tool_name),
            format!("risk: {}", self.request.risk.as_str()),
            format!("title: {}", self.request.title),
            format!("detail: {}", self.request.detail),
        ];

        if !self.request.risk_reasons.is_empty() {
            lines.push(format!(
                "risk reasons: {}",
                self.request.risk_reasons.join(", ")
            ));
        }

        if let Some(command) = &self.request.command {
            lines.push(format!("command: {command}"));
        }

        if let Some(paths) = &self.request.paths {
            lines.push(format!("paths: {}", paths.join(", ")));
        }

        if self.request.persistable {
            lines.push(format!(
                "persist: {} (press p to toggle never/session)",
                self.persist.as_str()
            ));
        }

        lines.push("approve: y, reject: n".to_owned());
        lines
    }

    pub fn handle_input(&mut self, input: &str) -> ApprovalPromptAction {
        match input.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" => ApprovalPromptAction::Approved {
                persist: self.persist,
            },
            "n" | "no" | "q" | "esc" => ApprovalPromptAction::Rejected {
                reason: APPROVAL_REJECTED_REASON.to_owned(),
            },
            "p" if self.request.persistable => {
                self.toggle_persistence();
                ApprovalPromptAction::Pending
            }
            _ => ApprovalPromptAction::Pending,
        }
    }

    pub fn decision_for_action(action: ApprovalPromptAction) -> Option<ApprovalDecision> {
        match action {
            ApprovalPromptAction::Approved { .. } => Some(ApprovalDecision::Approved),
            ApprovalPromptAction::Rejected { reason } => {
                Some(ApprovalDecision::Rejected { reason })
            }
            ApprovalPromptAction::Pending => None,
        }
    }

    fn toggle_persistence(&mut self) {
        self.persist = match self.persist {
            ApprovalPersistence::Never => ApprovalPersistence::Session,
            ApprovalPersistence::Session | ApprovalPersistence::Workspace => {
                ApprovalPersistence::Never
            }
        };
    }
}

#[cfg(test)]
mod tests {
    use prole_coder_agent_core::approval::{ApprovalPersistence, RiskLevel};

    use super::{APPROVAL_REJECTED_REASON, ApprovalPromptAction, ApprovalPromptModel};
    use prole_coder_agent_core::turn_loop::{ApprovalDecision, TurnApprovalRequest};

    #[test]
    fn approval_prompt_renders_tool_context() {
        let model = ApprovalPromptModel::new(sample_request(true));

        let lines = model.render_lines();

        assert!(lines.iter().any(|line| line == "tool: shell"));
        assert!(lines.iter().any(|line| line == "risk: exec"));
        assert!(lines.iter().any(|line| line == "command: cargo test"));
        assert!(
            lines
                .iter()
                .any(|line| line == "paths: crates/cli/src/lib.rs")
        );
        assert!(
            lines
                .iter()
                .any(|line| line == "persist: never (press p to toggle never/session)")
        );
    }

    #[test]
    fn approval_prompt_approves_rejects_and_ignores_unknown_input() {
        let mut model = ApprovalPromptModel::new(sample_request(false));

        assert_eq!(model.handle_input("?"), ApprovalPromptAction::Pending);
        assert_eq!(
            model.handle_input("y"),
            ApprovalPromptAction::Approved {
                persist: ApprovalPersistence::Never
            }
        );

        let rejected = model.handle_input("n");
        assert_eq!(
            rejected,
            ApprovalPromptAction::Rejected {
                reason: APPROVAL_REJECTED_REASON.to_owned()
            }
        );
        assert_eq!(
            ApprovalPromptModel::decision_for_action(rejected),
            Some(ApprovalDecision::Rejected {
                reason: APPROVAL_REJECTED_REASON.to_owned()
            })
        );
    }

    #[test]
    fn approval_prompt_toggles_persistence_only_when_request_allows_it() {
        let mut persistable = ApprovalPromptModel::new(sample_request(true));
        assert_eq!(persistable.persist(), ApprovalPersistence::Never);
        assert_eq!(persistable.handle_input("p"), ApprovalPromptAction::Pending);
        assert_eq!(persistable.persist(), ApprovalPersistence::Session);
        assert_eq!(
            persistable.handle_input("yes"),
            ApprovalPromptAction::Approved {
                persist: ApprovalPersistence::Session
            }
        );

        let mut non_persistable = ApprovalPromptModel::new(sample_request(false));
        assert_eq!(
            non_persistable.handle_input("p"),
            ApprovalPromptAction::Pending
        );
        assert_eq!(non_persistable.persist(), ApprovalPersistence::Never);
    }

    fn sample_request(persistable: bool) -> TurnApprovalRequest {
        TurnApprovalRequest {
            approval_id: "approval_1".to_owned(),
            tool_call_id: "tool_call_1".to_owned(),
            tool_name: "shell".to_owned(),
            risk: RiskLevel::Exec,
            title: "Execute shell command".to_owned(),
            detail: "Run verification".to_owned(),
            command: Some("cargo test".to_owned()),
            cwd: Some(".".to_owned()),
            output_summary: None,
            paths: Some(vec!["crates/cli/src/lib.rs".to_owned()]),
            hunks: None,
            risk_reasons: Vec::new(),
            persistable,
        }
    }
}
