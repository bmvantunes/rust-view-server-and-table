//! Selected execution adapter. Only this module exposes Timely/DD internally.
//! The boundary is deliberately concrete: no registry, plugin system or second backend.
use std::{cell::RefCell, rc::Rc};
use differential_dataflow::input::InputSession;
use timely::communication::{Allocator, allocator::thread::Thread as ThreadAllocator};
use timely::dataflow::operators::probe::Handle as ProbeHandle;
use timely::worker::{Config as WorkerConfig, Worker};

use crate::execution_contract::{MembershipChange, Completion};
pub(crate) struct MembershipEngine {
    worker: Worker,
    input: InputSession<u64, (u64, (String, String)), isize>,
    probe: ProbeHandle<u64>,
    output: Rc<RefCell<Vec<MembershipChange>>>,
}
impl MembershipEngine {
    pub fn new() -> Self {
        let allocator = Allocator::Thread(ThreadAllocator::default());
        let mut worker = Worker::new(WorkerConfig::default(), allocator, None);
        let mut input = InputSession::<u64, (u64, (String, String)), isize>::new();
        let probe = ProbeHandle::new();
        let output = Rc::new(RefCell::new(Vec::new()));
        let captured = Rc::clone(&output);
        worker.dataflow(|scope| {
            input.to_collection(scope).inspect(move |((shape, (id, order)), _time, weight)| {
                captured.borrow_mut().push(MembershipChange { shape: *shape, id: id.clone(), order: order.clone(), weight: *weight });
            }).probe_with(&probe);
        });
        Self { worker, input, probe, output }
    }
    pub fn apply_batch(&mut self, changes: impl IntoIterator<Item = MembershipChange>) {
        for change in changes { self.input.update((change.shape, (change.id, change.order)), change.weight); }
    }
    pub fn complete(&mut self) -> Result<Completion, String> {
        let frontier = self.input.time().checked_add(1).ok_or("engine frontier overflow")?;
        self.input.advance_to(frontier);
        self.input.flush();
        while self.probe.less_than(&frontier) { self.worker.step(); }
        Ok(Completion { changes: std::mem::take(&mut *self.output.borrow_mut()) })
    }
}

mod distinct;

