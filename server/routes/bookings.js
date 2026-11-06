// Bookings & Shoots. Every change answers with the booking's whole page (booking, payments, activity, team clashes),
// so the page redraws from one reply. The browser sends ?today= so "today" and "tomorrow" follow its calendar.
import express from 'express';
import * as v from '../util.js';
import { isoDate } from '../../shared/format.js';
import * as bk from '../services/bookings.js';

const router = express.Router();
export const teamRouter = express.Router();

const todayOf = (req) => v.optionalDate(req.query.today) || isoDate();
const detail = (req) => bk.bookingDetail(req.businessId, req.params.id, todayOf(req));

/** Run a change on the booking in the URL, then answer with its page. */
const change = (fn, status = 200) => (req, res) => {
  fn(req, req.body || {});
  res.status(status).json(detail(req));
};

router.get('/', (req, res) => res.json(bk.listBookings(req.businessId, req.query, todayOf(req))));
router.get('/overview', (req, res) => res.json(bk.bookingOverview(req.businessId, todayOf(req))));

router.post('/', (req, res) => {
  const id = bk.createBooking(req.businessId, req.user.id, req.body || {});
  res.status(201).json(bk.bookingDetail(req.businessId, id, todayOf(req)));
});

router.get('/:id', (req, res) => res.json(detail(req)));
router.put('/:id', change((req, body) => bk.updateBooking(req.businessId, req.user.id, req.params.id, body)));
router.put('/:id/status', change((req, body) => bk.setStatus(req.businessId, req.user.id, req.params.id, body)));
router.put('/:id/team', change((req, body) => bk.setTeam(req.businessId, req.user.id, req.params.id, body)));
router.put('/:id/checklist', change((req, body) => bk.setChecklist(req.businessId, req.user.id, req.params.id, body)));
router.put('/:id/tasks', change((req, body) => bk.setTask(req.businessId, req.user.id, req.params.id, body)));
router.put('/:id/deadlines', change((req, body) => bk.setDeadlines(req.businessId, req.user.id, req.params.id, body)));
router.put('/:id/delivery', change((req, body) => bk.setDelivery(req.businessId, req.user.id, req.params.id, body)));
router.put('/:id/notes', change((req, body) => bk.setNotes(req.businessId, req.params.id, body)));
router.post('/:id/links', change((req, body) => bk.addLink(req.businessId, req.user.id, req.params.id, body), 201));
router.delete('/:id/links/:linkId', change((req) => bk.removeLink(req.businessId, req.user.id, req.params.id, req.params.linkId)));
router.post('/:id/payments', change((req, body) => bk.addBookingPayment(req.businessId, req.user.id, req.params.id, body), 201));
router.delete('/:id/payments/:paymentId', change((req) => bk.deleteBookingPayment(req.businessId, req.user.id, req.params.id, req.params.paymentId)));
router.delete('/:id', (req, res) => res.json(bk.deleteBooking(req.businessId, req.params.id)));

// The studio's team: the people who can be put on a shoot.
teamRouter.get('/', (req, res) => res.json({ members: bk.listTeam(req.businessId) }));
teamRouter.post('/', (req, res) => res.status(201).json({ member: bk.createMember(req.businessId, req.body || {}) }));
teamRouter.put('/:id', (req, res) => res.json({ member: bk.updateMember(req.businessId, req.params.id, req.body || {}) }));
teamRouter.delete('/:id', (req, res) => res.json(bk.removeMember(req.businessId, req.params.id)));

export default router;
