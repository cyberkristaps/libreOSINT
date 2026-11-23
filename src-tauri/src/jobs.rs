//! Cancellable background jobs (transform runs, Ollama requests) keyed by a UI-provided job id.
//!
//! Aborting a job drops its future; for transforms that drops the child process handle, which is
//! spawned with `kill_on_drop(true)`, so the subprocess is killed too.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use tokio::task::AbortHandle;

use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct Jobs {
    running: Mutex<HashMap<String, AbortHandle>>,
}

impl Jobs {
    /// Run `fut` as a job that `cancel(job_id)` can abort.
    pub async fn run<T, F>(&self, job_id: &str, fut: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: Future<Output = AppResult<T>> + Send + 'static,
    {
        let handle = tokio::spawn(fut);
        self.lock().insert(job_id.to_owned(), handle.abort_handle());
        let result = handle.await;
        self.lock().remove(job_id);
        match result {
            Ok(r) => r,
            Err(e) if e.is_cancelled() => Err(AppError::Cancelled),
            Err(e) => Err(AppError::Storage(format!("job {job_id} failed: {e}"))),
        }
    }

    /// Abort a running job. Returns false when no such job is running.
    pub fn cancel(&self, job_id: &str) -> bool {
        match self.lock().remove(job_id) {
            Some(h) => {
                h.abort();
                true
            }
            None => false,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, AbortHandle>> {
        // A poisoned map only means a panic happened mid-insert; the data is still usable.
        self.running.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn completes_and_cancels() {
        let jobs = std::sync::Arc::new(Jobs::default());
        assert_eq!(jobs.run("a", async { Ok(1) }).await.unwrap(), 1);

        let j = jobs.clone();
        let slow = tokio::spawn(async move {
            j.run("b", async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(())
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(jobs.cancel("b"));
        assert!(matches!(slow.await.unwrap(), Err(AppError::Cancelled)));
        assert!(!jobs.cancel("b"));
    }
}
